//! The Modern Events logo as an LED panel (panel.js): a block of dots in the logo's blue-violet
//! gradient with "MODERN EVENTS" in white dots (like the LED panel on modern-events.de). Every dot is
//! a particle on a spring to its place.
//!
//! The people show up in the panel itself: the background dots they cover light up in the people's
//! colors, the letters stay white, so the logo stays readable however many stand there. Moving
//! outlines kick the dots (BodyField kicks): walking through the logo or waving in it splashes the
//! dots, which spring back as soon as one stands still. Ripples (someone arrives, attract loop) run
//! through it. Optionally ("push") the dots also make way for the bodies like a curtain.
//!
//! Drawn as instanced quads on whole LEDs in two draws: first the black backing of the dots still at
//! home (it hides the people layer behind the intact panel), then the dots themselves.

use std::f32::consts::PI;

use wall::gpu::{Gpu, TARGET_FORMAT, layout};
use wall::params::Params;
use wall::persons::hex_rgb;
use wall::common::field::BodyField;
use wall::map::WallMap;

use super::paint::{Job, LetterSpec, Painter};

const FLOATS: usize = 8; // x, y (px), half cell (px), dot radius (px), r, g, b, backing alpha

const WGSL: &str = r"
@group(0) @binding(0) var<uniform> res: vec4f;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) col: vec3f,
  @location(2) back: f32,
  @location(3) rad: f32,
};
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) c: vec4f) -> VOut {
  var corner = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let local = corner[vi] * a.z;
  let p = a.xy + local;
  var out: VOut;
  out.pos = vec4f(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, 0.0, 1.0);
  out.local = local;
  out.col = c.rgb;
  out.back = c.a;
  out.rad = a.w;
  return out;
}
@fragment fn fsBack(in: VOut) -> @location(0) vec4f { return vec4f(0.0, 0.0, 0.0, in.back); }
@fragment fn fsDot(in: VOut) -> @location(0) vec4f {
  let cover = clamp(in.rad - length(in.local) + 0.5, 0.0, 1.0);
  return vec4f(in.col * cover, cover);
}
";

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// The panel's rect (px) and dot pitch, and the text: what the dots are built for.
#[derive(Clone, PartialEq, Debug)]
struct Key {
    rect: [f64; 4],
    pitch: f64,
    text: String,
}

struct Ripple {
    x: f32,
    y: f32,
    t0: f64,
    amp: f32,
}

pub struct LogoPanel {
    back: wgpu::RenderPipeline,
    dot: wgpu::RenderPipeline,
    res: wgpu::Buffer,
    group: wgpu::BindGroup,
    buffer: wgpu::Buffer,
    capacity: usize,
    key: Option<Key>,
    /// the letter cells at hand, and the ones asked for
    cells: Option<(LetterSpec, Vec<u8>)>,
    asked: Option<LetterSpec>,
    n: usize,
    home: Vec<f32>,
    pos: Vec<f32>,
    vel: Vec<f32>,
    base: Vec<f32>,
    letter: Vec<bool>,
    /// per dot: 0 nobody, 1 a person, 2 a person's outline
    cover: Vec<u8>,
    data: Vec<f32>,
    last_seq: Option<u64>,
    rect: [f32; 4],
    pitch: f32,
    ripples: Vec<Ripple>,
}

/// The dot grid of a panel rect: cols, rows.
pub fn grid(rect: [f64; 4], pitch: f64) -> (usize, usize) {
    ((rect[2] / pitch).floor().max(4.0) as usize, (rect[3] / pitch).floor().max(3.0) as usize)
}

impl LogoPanel {
    /// `capacity`: dots the instance buffer holds at first (it grows if a panel needs more).
    pub fn new(gpu: &Gpu, capacity: usize) -> Result<Self, String> {
        let module = gpu.shader("modern-events: panel", WGSL)?;
        let bgl = gpu.bind_group_layout("modern-events panel", &[layout::uniform(0, wgpu::ShaderStages::VERTEX)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("modern-events panel"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let pipe = |entry: &str| {
            gpu.render_pipeline(&format!("modern-events panel {entry}"), |d| {
                d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("modern-events panel"),
                    layout: Some(&pl),
                    vertex: wgpu::VertexState {
                        module: &module,
                        entry_point: Some("vs"),
                        compilation_options: Default::default(),
                        buffers: &[Some(wgpu::VertexBufferLayout {
                            array_stride: (FLOATS * 4) as u64,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: &[
                                wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 0, shader_location: 0 },
                                wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 16, shader_location: 1 },
                            ],
                        })],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &module,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState { format: TARGET_FORMAT, blend: Some(wgpu::BlendState { color: blend, alpha: blend }), write_mask: wgpu::ColorWrites::ALL })],
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                })
            })
        };
        let back = pipe("fsBack")?;
        let dot = pipe("fsDot")?;
        let res = gpu.uniform_buffer("modern-events panel res", 16);
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("modern-events panel"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: res.as_entire_binding() }],
        });
        let capacity = capacity.max(64);
        let buffer = Self::dot_buffer(gpu, capacity);
        Ok(Self {
            back,
            dot,
            res,
            group,
            buffer,
            capacity,
            key: None,
            cells: None,
            asked: None,
            n: 0,
            home: Vec::new(),
            pos: Vec::new(),
            vel: Vec::new(),
            base: Vec::new(),
            letter: Vec::new(),
            cover: Vec::new(),
            data: Vec::new(),
            last_seq: None,
            rect: [0.0; 4],
            pitch: 6.0,
            ripples: Vec::with_capacity(9),
        })
    }

    fn dot_buffer(gpu: &Gpu, dots: usize) -> wgpu::Buffer {
        gpu.buffer("modern-events panel dots", (dots * FLOATS * 4) as u64, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST)
    }

    /// The letter cells the painter made.
    pub fn set_cells(&mut self, spec: LetterSpec, cells: Vec<u8>) {
        if self.asked.as_ref() == Some(&spec) {
            self.asked = None;
        }
        self.cells = Some((spec, cells));
    }

    /// panel.js build(): (re)builds the dots for a panel rect (px) when it or the text changes. New
    /// letter cells come from the painter (painter None, in the setup: painted right here); until
    /// they are there the old dots stay.
    pub fn want(&mut self, gpu: &Gpu, rect: [f64; 4], pitch: f64, text: &str, painter: Option<&Painter>) {
        if self.key.as_ref().is_some_and(|k| k.rect == rect && k.pitch == pitch && k.text == text) {
            return;
        }
        let (cols, rows) = grid(rect, pitch);
        let is = |s: &LetterSpec| s.cols == cols && s.rows == rows && s.text == text;
        let ready = self.cells.as_ref().is_some_and(|(s, c)| is(s) && c.len() == cols * rows);
        if !ready {
            match painter {
                Some(p) => {
                    if !self.asked.as_ref().is_some_and(is) {
                        let spec = LetterSpec { cols, rows, text: text.to_string() };
                        p.ask(Job::Letters(spec.clone()));
                        self.asked = Some(spec);
                    }
                    return;
                }
                None => {
                    let spec = LetterSpec { cols, rows, text: text.to_string() };
                    let cells = super::paint::letter_cells(&spec);
                    self.cells = Some((spec, cells));
                }
            }
        }
        self.build(gpu, rect, pitch, text, cols, rows);
    }

    fn build(&mut self, gpu: &Gpu, rect: [f64; 4], pitch: f64, text: &str, cols: usize, rows: usize) {
        let Some((_, cells)) = &self.cells else { return };
        self.key = Some(Key { rect, pitch, text: text.to_string() });
        let p = pitch as f32;
        self.rect = [rect[0] as f32, rect[1] as f32, rect[2] as f32, rect[3] as f32];
        self.pitch = p;
        let x0 = rect[0] as f32 + ((rect[2] - cols as f64 * pitch) / 2.0).floor() as f32;
        let y0 = rect[1] as f32 + ((rect[3] - rows as f64 * pitch) / 2.0).floor() as f32;
        // the logo block, a bit brighter than on screen (LEDs on black)
        let (blue, indigo, purple, pink, white) = (hex_rgb("#2c40c4"), hex_rgb("#3d32b4"), hex_rgb("#8a2b9c"), hex_rgb("#d8327e"), hex_rgb("#fffbf1"));
        let round = 2.6; // corner radius in cells
        // in f64 as the browser: the facets' diagonals fall on exact multiples
        let (cf, rf, pf) = (cols as f64, rows as f64, pitch);
        self.home.clear();
        self.base.clear();
        self.letter.clear();
        for row in 0..rows {
            for col in 0..cols {
                let (c, r) = (col as f64 + 0.5, row as f64 + 0.5);
                // rounded corners of the block
                let dx = (round - c).max(c - (cf - round)).max(0.0);
                let dy = (round - r).max(r - (rf - round)).max(0.0);
                if dx * dx + dy * dy > round * round {
                    continue;
                }
                let u = c / cf;
                let v = r / rf;
                // the logo's gradient: blue, indigo, purple; pink in two corners; faint diagonal facets
                let mut k = if u < 0.5 { mix3(blue, indigo, (u * 2.0) as f32) } else { mix3(indigo, purple, ((u - 0.5) * 2.0) as f32) };
                let aspect = (rf * pf) / (cf * pf);
                let bl = u + (1.0 - v) * aspect * 0.55;
                let tr = 1.0 - u + v * aspect * 0.55;
                if bl < 0.09 {
                    k = mix3(k, pink, 0.85);
                } else if tr < 0.07 {
                    k = mix3(k, pink, 0.7);
                }
                let facet = if ((u * cf + v * rf) / (rf * 1.6)).floor() as i64 % 2 != 0 { 1.0 } else { 0.86 };
                let is_letter = cells.get(row * cols + col).copied().unwrap_or(0) == 1;
                let k = if is_letter { white } else { [k[0] * facet, k[1] * facet, k[2] * facet] };
                self.home.extend_from_slice(&[x0 + col as f32 * p + p / 2.0, y0 + row as f32 * p + p / 2.0]);
                self.base.extend_from_slice(&k);
                self.letter.push(is_letter);
            }
        }
        self.n = self.letter.len();
        self.pos.clone_from(&self.home);
        self.vel.clear();
        self.vel.resize(self.n * 2, 0.0);
        self.cover.clear();
        self.cover.resize(self.n, 0);
        self.data.clear();
        self.data.resize(self.n * FLOATS, 0.0);
        if self.n > self.capacity {
            self.capacity = self.n;
            self.buffer = Self::dot_buffer(gpu, self.n);
        }
    }

    /// A ripple from (x, y) px through the panel.
    pub fn ripple(&mut self, x: f32, y: f32, amp: f32, now: f64) {
        self.ripples.push(Ripple { x, y, t0: now, amp });
        if self.ripples.len() > 8 {
            self.ripples.remove(0);
        }
    }

    /// One simulation step. field: the bodies (None = nobody). Returns how many dots are out of
    /// place (for the status line).
    #[allow(clippy::too_many_arguments)]
    pub fn step(&mut self, field: Option<&BodyField>, p: &Params, wall: &WallMap, width: u32, height: u32, dt: f32, now: f64) -> usize {
        if self.n == 0 {
            return 0;
        }
        let s = &wall.setup;
        let sx = s.size_w / width.max(1) as f32;
        let sy = s.size_h / height.max(1) as f32;
        let top = s.bottom + s.size_h;
        let dt_all = dt.min(0.1);
        let subs = 2;
        let dt = dt_all / subs as f32;
        let w0 = 2.0 * PI * p.f("springHz");
        let k = w0 * w0;
        let damp = 2.0 * 0.45 * w0;
        let margin = 0.05; // m: with "push", the dots settle about this far outside the outline
        let push = 9000.0 * p.f("push"); // px/s^2 at the outline
        let max_v = 2600.0;
        self.ripples.retain(|r| now - r.t0 <= 3.0);

        // who stands on which dot (its home), and the kicks of moving outlines (once per result)
        let fresh = field.is_some_and(|f| Some(f.seq) != self.last_seq);
        if let Some(f) = field {
            self.last_seq = Some(f.seq);
        }
        let kick_gain = 520.0 * p.f("kick"); // px/s per cell the outline moved
        let mut out = 0;
        for i in 0..self.n {
            let ix = 2 * i;
            let (mut x, mut y) = (self.pos[ix], self.pos[ix + 1]);
            let (mut vx, mut vy) = (self.vel[ix], self.vel[ix + 1]);
            let (hx, hy) = (self.home[ix], self.home[ix + 1]);
            match field {
                Some(f) => {
                    self.cover[i] = match f.cell_at(hx * sx, top - hy * sy, top) {
                        Some(c) if f.occ.get(c).is_some_and(|o| *o != 0) => {
                            if f.sd.get(c).is_some_and(|d| *d > -1.6 * f.cell) {
                                2
                            } else {
                                1
                            }
                        }
                        _ => 0,
                    };
                    if fresh && let Some(q) = f.cell_at(x * sx, top - y * sy, top) {
                        vx += f.kx.get(q).copied().unwrap_or(0.0) * kick_gain;
                        vy -= f.ky.get(q).copied().unwrap_or(0.0) * kick_gain;
                    }
                }
                None => self.cover[i] = 0,
            }
            for _ in 0..subs {
                let mut ax = k * (hx - x) - damp * vx;
                let mut ay = k * (hy - y) - damp * vy;
                if let Some(f) = field
                    && push > 0.0
                {
                    let [d, sgx, sgy] = f.sample(x * sx, top - y * sy, top);
                    if d < margin {
                        let (mut gx, mut gy) = (sgx, -sgy); // to px: y down
                        let gl = gx.hypot(gy);
                        if gl > 1e-3 {
                            gx /= gl;
                            gy /= gl;
                        } else {
                            gx = if i % 2 != 0 { 1.0 } else { -1.0 }; // on a body's middle line: sideways
                            gy = 0.0;
                        }
                        let f = push * ((margin - d) / margin).min(3.0);
                        ax += gx * f;
                        ay += gy * f;
                    }
                }
                for r in &self.ripples {
                    let age = (now - r.t0) as f32;
                    let dx = hx - r.x;
                    let dy = hy - r.y;
                    let dist = dx.hypot(dy) + 1e-3;
                    let q = (dist - age * 520.0) / 26.0;
                    if q > -3.0 && q < 3.0 {
                        let f = r.amp * 5200.0 * (-q * q).exp() * (1.0 - age / 2.2).max(0.0);
                        ax += dx / dist * f;
                        ay += dy / dist * f;
                    }
                }
                vx += ax * dt;
                vy += ay * dt;
                let sp = vx.hypot(vy);
                if sp > max_v {
                    vx *= max_v / sp;
                    vy *= max_v / sp;
                }
                x += vx * dt;
                y += vy * dt;
            }
            self.pos[ix] = x;
            self.pos[ix + 1] = y;
            self.vel[ix] = vx;
            self.vel[ix + 1] = vy;
            if (x - hx).abs() + (y - hy).abs() > self.pitch * 0.6 {
                out += 1;
            }
        }
        out
    }

    /// Writes the instances (render() of panel.js). brand(t): the people's gradient (the same as
    /// people.wgsl), t = 0..1 across the wall.
    pub fn prepare(&mut self, gpu: &Gpu, p: &Params, time: f64, width: u32, height: u32, brand: fn(f32) -> [f32; 3]) {
        if self.n == 0 {
            return;
        }
        let pitch = self.pitch;
        let half = pitch / 2.0;
        let rad = pitch * p.f("dotSize") * 0.5;
        let [rx, ry, rw, rh] = self.rect;
        // the glint: a diagonal band of light sweeping over the panel every few seconds
        let period = 7.0;
        let sweep = ((time % period) / 2.2) as f32 * (rw + rh * 2.0) - rh;
        let (letters, panel, people, rim, glint_k, backing) = (p.f("letters"), p.f("panel"), p.f("people"), p.f("rim"), p.f("glint"), p.f("backing"));
        let wf = width.max(1) as f32;
        for i in 0..self.n {
            let ix = 2 * i;
            let (x, y) = (self.pos[ix], self.pos[ix + 1]);
            let off = (x - self.home[ix]).hypot(y - self.home[ix + 1]);
            let speed = self.vel[ix].hypot(self.vel[ix + 1]);
            let back = 1.0 - ((off - pitch * 0.25) / (pitch * 0.9)).clamp(0.0, 1.0);
            let band = x - rx + (y - ry) * 0.6 - sweep;
            let glint = (-(band * band) / 1400.0).exp() * 0.5 * glint_k;
            let b3 = [self.base[3 * i], self.base[3 * i + 1], self.base[3 * i + 2]];
            let col = if self.letter[i] {
                [b3[0] * letters, b3[1] * letters, b3[2] * letters]
            } else if self.cover[i] != 0 {
                // a person on the panel: the dots light up in the people's colors, the outline lighter
                let c = brand(self.home[ix] / wf);
                let b = people * 1.1;
                let rim = if self.cover[i] == 2 { rim } else { 0.0 };
                [(c[0] + (1.0 - c[0]) * rim) * b, (c[1] + (1.0 - c[1]) * rim) * b, (c[2] + (1.0 - c[2]) * rim) * b]
            } else {
                [b3[0] * panel, b3[1] * panel, b3[2] * panel]
            };
            // fast dots flash, the glint lightens
            let boost = (speed / 1800.0).min(0.7) + glint;
            let o = i * FLOATS;
            let lit = |c: f32| (c * (1.0 + boost) + (1.0 - c) * boost * 0.6).min(1.0);
            self.data[o..o + FLOATS].copy_from_slice(&[x, y, half, rad, lit(col[0]), lit(col[1]), lit(col[2]), back * backing]);
        }
        gpu.queue.write_buffer(&self.res, 0, bytemuck::cast_slice(&[width as f32, height as f32, 0.0, 0.0]));
        gpu.queue.write_buffer(&self.buffer, 0, bytemuck::cast_slice(&self.data[..self.n * FLOATS]));
    }

    /// Backing, then the dots (into a pass that loads the people layer).
    pub fn draw(&self, pass: &mut wgpu::RenderPass) {
        if self.n == 0 {
            return;
        }
        pass.set_bind_group(0, &self.group, &[]);
        pass.set_vertex_buffer(0, self.buffer.slice(..(self.n * FLOATS * 4) as u64));
        pass.set_pipeline(&self.back);
        pass.draw(0..6, 0..self.n as u32);
        pass.set_pipeline(&self.dot);
        pass.draw(0..6, 0..self.n as u32);
    }
}
