//! Feasibility of splitting a pixel into two echoes (a glossy floor: its own weak echo and the
//! mirror image behind it). Per pixel, the three frequencies give three complex values, six
//! numbers; two echoes at distances u1 < u2 with amplitudes A1, A2 (the same at every frequency)
//! are four unknowns. A grid search over (u1, u2) with least squares for the amplitudes, against
//! the best single echo.
//!   cargo run --release -p kinect-driver --example two_echoes -- FILE.k2raw [--skip N] [--rows A..B] [--png DIR]
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use std::f32::consts::TAU;
use std::io::BufWriter;

use kinect_driver::consts::{FREQ_MULTIPLES, HEIGHT, PIXELS, WIDTH};
use kinect_driver::record::RawReader;
use kinect_driver::tables::depth_from_u;
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput};

/// Result of one pixel.
#[derive(Clone, Copy, Default)]
struct Fit {
    u1: f32,
    u2: f32,
    a1: f32,
    a2: f32,
    /// residual of the two-echo fit, of the best single echo
    r2: f32,
    r1: f32,
    u_single: f32,
}

fn steering(u: f32) -> [(f32, f32); 3] {
    std::array::from_fn(|k| {
        let ph = TAU * FREQ_MULTIPLES[k] as f32 * u;
        (ph.cos(), ph.sin())
    })
}

/// Least squares of z = A1 s1 + A2 s2 (A real): returns (A1, A2, residual).
fn fit2(z: &[(f32, f32); 3], s1: &[(f32, f32); 3], s2: &[(f32, f32); 3]) -> (f32, f32, f32) {
    let (mut g11, mut g12, mut g22, mut b1, mut b2, mut zz) = (0f32, 0f32, 0f32, 0f32, 0f32, 0f32);
    for k in 0..3 {
        g11 += s1[k].0 * s1[k].0 + s1[k].1 * s1[k].1;
        g22 += s2[k].0 * s2[k].0 + s2[k].1 * s2[k].1;
        g12 += s1[k].0 * s2[k].0 + s1[k].1 * s2[k].1;
        b1 += s1[k].0 * z[k].0 + s1[k].1 * z[k].1;
        b2 += s2[k].0 * z[k].0 + s2[k].1 * z[k].1;
        zz += z[k].0 * z[k].0 + z[k].1 * z[k].1;
    }
    let det = g11 * g22 - g12 * g12;
    if det.abs() < 1e-6 {
        return (0.0, 0.0, f32::INFINITY);
    }
    let a1 = (g22 * b1 - g12 * b2) / det;
    let a2 = (g11 * b2 - g12 * b1) / det;
    if a1 < 0.0 || a2 < 0.0 {
        return (a1, a2, f32::INFINITY);
    }
    (a1, a2, (zz - a1 * b1 - a2 * b2).max(0.0))
}

fn fit_pixel(z: &[(f32, f32); 3], grid: &[[(f32, f32); 3]], du: f32) -> Fit {
    let n = grid.len();
    let mut best = Fit { r2: f32::INFINITY, r1: f32::INFINITY, ..Fit::default() };
    let zz: f32 = z.iter().map(|(a, b)| a * a + b * b).sum();
    // single echo: A = Re(<s, z>) / 3
    for (i, s) in grid.iter().enumerate() {
        let p: f32 = (0..3).map(|k| s[k].0 * z[k].0 + s[k].1 * z[k].1).sum();
        let r = zz - p * p / 3.0;
        if p > 0.0 && r < best.r1 {
            best.r1 = r;
            best.u_single = i as f32 * du;
        }
    }
    // two echoes at least 10 grid steps apart
    for i in 0..n {
        for j in i + 10..n {
            let (a1, a2, r) = fit2(z, &grid[i], &grid[j]);
            if r < best.r2 {
                best = Fit { u1: i as f32 * du, u2: j as f32 * du, a1, a2, r2: r, ..best };
            }
        }
    }
    // refine around the best pair
    let (c1, c2) = (best.u1, best.u2);
    let fine = du / 10.0;
    for di in -10..=10 {
        for dj in -10..=10 {
            let (u1, u2) = (c1 + di as f32 * fine, c2 + dj as f32 * fine);
            if u1 < 0.0 || u2 <= u1 {
                continue;
            }
            let (a1, a2, r) = fit2(z, &steering(u1), &steering(u2));
            if r < best.r2 {
                best = Fit { u1, u2, a1, a2, r2: r, ..best };
            }
        }
    }
    best
}

fn color(d: f32, max: f32) -> [u8; 3] {
    if d <= 0.0 {
        return [0, 0, 0];
    }
    let t = (d / max).clamp(0.0, 1.0) * 4.0;
    let f = t.fract();
    let (r, g, b) = match t as u32 {
        0 => (0.0, f, 1.0),
        1 => (0.0, 1.0, 1.0 - f),
        2 => (f, 1.0, 0.0),
        3 => (1.0, 1.0 - f, 0.0),
        _ => (1.0, 0.0, 0.0),
    };
    [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
}

fn save_rgb(path: &str, px: &[[u8; 3]]) -> Result<(), Box<dyn std::error::Error>> {
    let f = std::fs::File::create(path)?;
    let mut e = png::Encoder::new(BufWriter::new(f), WIDTH as u32, HEIGHT as u32);
    e.set_color(png::ColorType::Rgb);
    e.set_depth(png::BitDepth::Eight);
    let mut w = e.write_header()?;
    w.write_image_data(&px.iter().flatten().copied().collect::<Vec<u8>>())?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let file = args.next().ok_or("FILE.k2raw")?;
    let (mut skip, mut rows, mut png) = (0usize, (300usize, HEIGHT), None::<String>);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--skip" => skip = args.next().ok_or("--skip N")?.parse()?,
            "--rows" => {
                let v = args.next().ok_or("--rows A..B")?;
                let (a, b) = v.split_once("..").ok_or("--rows A..B")?;
                rows = (a.parse()?, b.parse()?);
            }
            "--png" => png = Some(args.next().ok_or("--png DIR")?),
            other => return Err(format!("unknown {other}").into()),
        }
    }
    let mut reader = RawReader::open(std::path::Path::new(&file))?;
    let tables = reader.header().tables()?;
    let mut dec = CpuDecoder::new(TofConfig::extended())?;
    let mut out = TofOutput::new();
    for _ in 0..skip {
        reader.next_packet()?.ok_or("too short")?;
    }
    let p = reader.next_packet()?.ok_or("too short")?;
    dec.decode(&p, &tables, &mut out)?;
    let du = 0.002f32;
    // up to half the range (9.4 m): the rooms here are smaller
    let grid: Vec<[(f32, f32); 3]> = (0..(0.5 / du) as usize).map(|i| steering(i as f32 * du)).collect();
    let mut fits = vec![Fit::default(); PIXELS];
    let t0 = std::time::Instant::now();
    // 3 x 3 mean of the complex values (as the bilateral filter on a smooth surface)
    let z_at = |x: usize, y: usize| -> [(f32, f32); 3] {
        std::array::from_fn(|k| {
            let (mut a, mut b, mut n) = (0f32, 0f32, 0f32);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (xx, yy) = (x as i32 + dx, y as i32 + dy);
                    if xx < 0 || yy < 0 || xx >= WIDTH as i32 || yy >= HEIGHT as i32 {
                        continue;
                    }
                    if let Some((sa, sb)) = dec.sample(k, yy as usize * WIDTH + xx as usize) {
                        a += sa;
                        b += sb;
                        n += 1.0;
                    }
                }
            }
            (a / n.max(1.0), b / n.max(1.0))
        })
    };
    let rows_v: Vec<usize> = (rows.0..rows.1.min(HEIGHT)).collect();
    std::thread::scope(|s| {
        let chunks: Vec<_> = fits.chunks_mut(WIDTH).enumerate().filter(|(y, _)| rows_v.contains(y)).collect();
        let per = chunks.len().div_ceil(6).max(1);
        let mut it = chunks.into_iter();
        loop {
            let part: Vec<_> = it.by_ref().take(per).collect();
            if part.is_empty() {
                break;
            }
            let (grid, z_at) = (&grid, &z_at);
            s.spawn(move || {
                for (y, row) in part {
                    for (x, f) in row.iter_mut().enumerate() {
                        *f = fit_pixel(&z_at(x, y), grid, du);
                    }
                }
            });
        }
    });
    println!("fitted rows {}..{} in {:.1} s", rows.0, rows.1, t0.elapsed().as_secs_f32());
    let mm = |u: f32, i: usize| depth_from_u(u, tables.xtable[i], tables.ztable[i]);
    // summary: pixels where two echoes explain much better than one, and how strong the first is
    let (mut n, mut better, mut first_weaker) = (0u32, 0u32, 0u32);
    for y in rows.0..rows.1.min(HEIGHT) {
        for x in 0..WIDTH {
            let i = y * WIDTH + x;
            let f = fits[i];
            if !f.r2.is_finite() || f.a1 + f.a2 < 1.0 {
                continue;
            }
            n += 1;
            if f.r2 < 0.25 * f.r1 {
                better += 1;
                first_weaker += u32::from(f.a1 < f.a2);
            }
        }
    }
    println!("pixels {n}: two echoes explain at least 4x better {better}, of those the first is the weaker {first_weaker}");
    for x in (40..WIDTH).step_by(60) {
        let y = (rows.0 + rows.1.min(HEIGHT)) / 2;
        let i = y * WIDTH + x;
        let f = fits[i];
        println!(
            "  x {x:>3} y {y:>3}: decoder {:>6.0} mm | one echo {:>6.0} mm res {:>8.2} | two: {:>6.0} mm a {:>6.1} + {:>6.0} mm a {:>6.1} res {:>8.2}",
            out.depth[i], mm(f.u_single, i), f.r1, mm(f.u1, i), f.a1, mm(f.u2, i), f.a2, f.r2
        );
    }
    if let Some(dir) = png {
        std::fs::create_dir_all(&dir)?;
        let max = 6000.0;
        let pick = |g: &dyn Fn(usize, &Fit) -> f32| -> Vec<[u8; 3]> {
            (0..PIXELS).map(|i| color(if fits[i].r2.is_finite() && fits[i].a1 + fits[i].a2 >= 1.0 { g(i, &fits[i]) } else { 0.0 }, max)).collect()
        };
        save_rgb(&format!("{dir}/decoder.png"), &out.depth.iter().map(|d| color(*d, max)).collect::<Vec<_>>())?;
        save_rgb(&format!("{dir}/first-echo.png"), &pick(&|i, f| mm(f.u1, i)))?;
        save_rgb(&format!("{dir}/second-echo.png"), &pick(&|i, f| mm(f.u2, i)))?;
        // share of the first echo: black 0, white 1
        let share: Vec<[u8; 3]> = fits.iter().map(|f| if f.r2.is_finite() && f.a1 + f.a2 >= 1.0 { let t = (255.0 * f.a1 / (f.a1 + f.a2)) as u8; [t, t, t] } else { [0, 0, 0] }).collect();
        save_rgb(&format!("{dir}/first-share.png"), &share)?;
        // depth planes as raw f32 for the side view: decoder, first, second
        let mut raw = Vec::with_capacity(PIXELS * 12);
        for i in 0..PIXELS {
            let f = fits[i];
            let ok = f.r2.is_finite() && f.a1 + f.a2 >= 1.0;
            for v in [out.depth[i], if ok { mm(f.u1, i) } else { 0.0 }, if ok { mm(f.u2, i) } else { 0.0 }, if ok { f.a1 / (f.a1 + f.a2) } else { 0.0 }] {
                raw.extend_from_slice(&v.to_le_bytes());
            }
        }
        std::fs::write(format!("{dir}/planes.f32"), raw)?;
        println!("PNGs in {dir}");
    }
    Ok(())
}
