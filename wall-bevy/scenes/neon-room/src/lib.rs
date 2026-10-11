//! Neon-Raum (port of web/scenes/neon-room): only the people from the Kinect, as lit point clouds in
//! a minimal virtual room — a dark glossy floor with a neon grid fading into the fog, a glowing
//! horizon, a ring of light in their color under every person, the field of view of the sensor on
//! the floor, their reflection.
//!
//! Built on the person tracking: the depth of the person pixels only, their slot per pixel, the list
//! of persons and the floor plane. The floor of the room is the real floor; without one the sensor
//! counts as level and the floor goes under the lowest person.
//! The browser scene's own WGSL: points (additive, rgba16f) -> mirrored points (half res, blurred)
//! -> glow (quarter res) -> one fullscreen pass that draws the room and puts everything together.
//! tags.rs: the id and height above every person (HTML on top of the canvas in the browser).
//! The camera is ctx.camera of a page nobody touches: its default pose and slow automatic orbit.

mod tags;

use wall::glam::Vec3;

use wall::gpu::{Gpu, TARGET_FORMAT, begin_pass, layout};
use wall::params::{ParamSpec, Params, boolean, color, num};
use wall::persons::{MAX_PERSONS, PERSON_COLORS, RawPerson, RoomFrame, hex_rgb, room_frame};
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, exact, no_cap, no_projection};

const POINTS_WGSL: &str = include_str!("../../../../web/scenes/neon-room/points.wgsl");
const ROOM_WGSL: &str = include_str!("../../../../web/scenes/neon-room/room.wgsl");
const GLOW_WGSL: &str = include_str!("../../../../web/scenes/neon-room/glow.wgsl");

const DEG: f64 = std::f64::consts::PI / 180.0;
/// ctx.camera.zoom after its reset()
const ZOOM: f64 = 1.6;
const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// floats of the uniforms (points.wgsl Uniforms: 512 bytes, room.wgsl Room: 768 bytes)
const POINT_FLOATS: usize = 128;
const ROOM_FLOATS: usize = 192;

fn params() -> Vec<ParamSpec> {
    vec![
        num("dotFill", 0.62, 0.2, 1.4, 0.01, "Punktgröße"),
        num("gain", 1.6, 0.3, 4.0, 0.05, "Helligkeit"),
        num("glow", 0.55, 0.0, 2.0, 0.01, "Glow"),
        num("rim", 0.9, 0.0, 2.0, 0.01, "Randlicht"),
        num("whiteMix", 0.25, 0.0, 1.0, 0.01, "Weiß im Licht"),
        num("irDetail", 0.35, 0.0, 1.0, 0.01, "IR-Details"),
        boolean("scan", true, "Scan-Streifen"),
        boolean("labels", true, "ID und Größe"),
        num("reflection", 0.45, 0.0, 1.5, 0.01, "Spiegelung"),
        num("grid", 0.55, 0.0, 1.5, 0.01, "Gitter"),
        num("gridSize", 0.5, 0.1, 2.0, 0.05, "Gitterweite (m)"),
        num("rings", 1.0, 0.0, 2.0, 0.01, "Ringe"),
        num("fovLines", 0.7, 0.0, 2.0, 0.01, "Sichtfeld der Kinect"),
        num("horizon", 0.75, 0.0, 2.0, 0.01, "Horizont"),
        color("gridColor", "#1ad8ff", "Gitterfarbe"),
        color("horizonColor", "#7a3cff", "Horizontfarbe"),
        color("skyColor", "#020309", "Himmel"),
        color("floorColor", "#03050b", "Boden"),
        num("distance", 4.2, 1.5, 10.0, 0.05, "Abstand (m)"),
        num("lookHeight", 1.0, 0.2, 2.0, 0.01, "Blickhöhe (m)"),
        num("fov", 42.0, 20.0, 80.0, 1.0, "Bildwinkel (°)"),
        num("sensorHeight", 1.0, 0.2, 3.0, 0.01, "Kinect-Höhe ohne Boden (m)"),
    ]
}

/// the IR stream only while it is used
fn streams(p: &Params) -> Vec<&'static str> {
    if p.f("irDetail") > 0.0 { vec!["ir"] } else { Vec::new() }
}

// ---------- matrices (column-major, as WGSL mat4x4f), in f64 as the browser computes them ----------

type M4 = [f64; 16];

/// left-handed like ctx.camera: rows right, up, forward
fn look_at(eye: [f64; 3], target: [f64; 3]) -> M4 {
    let mut f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    let lf = len3(f);
    f = f.map(|x| x / lf);
    let r0 = [f[2], 0.0, -f[0]];
    let lr = len3(r0);
    let r = r0.map(|x| x / lr);
    let u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    let d = |a: [f64; 3]| a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
    [r[0], u[0], f[0], 0.0, r[1], u[1], f[1], 0.0, r[2], u[2], f[2], 0.0, -d(r), -d(u), -d(f), 1.0]
}

/// |a|, 1 for a zero vector (Math.hypot(...) || 1)
fn len3(a: [f64; 3]) -> f64 {
    let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    if l > 0.0 { l } else { 1.0 }
}

fn perspective(fov_y_deg: f64, aspect: f64, near: f64, far: f64) -> M4 {
    let sy = 1.0 / ((fov_y_deg * DEG) / 2.0).tan();
    let sx = sy / aspect;
    let a = far / (far - near);
    [sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, a, 1.0, 0.0, 0.0, -near * a, 0.0]
}

fn mul(a: &M4, b: &M4) -> M4 {
    let mut o = [0.0; 16];
    for c in 0..4 {
        for r in 0..4 {
            o[c * 4 + r] = (0..4).map(|k| a[k * 4 + r] * b[c * 4 + k]).sum();
        }
    }
    o
}

fn invert(m: &M4) -> M4 {
    let [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = *m;
    let b00 = a00 * a11 - a01 * a10;
    let b01 = a00 * a12 - a02 * a10;
    let b02 = a00 * a13 - a03 * a10;
    let b03 = a01 * a12 - a02 * a11;
    let b04 = a01 * a13 - a03 * a11;
    let b05 = a02 * a13 - a03 * a12;
    let b06 = a20 * a31 - a21 * a30;
    let b07 = a20 * a32 - a22 * a30;
    let b08 = a20 * a33 - a23 * a30;
    let b09 = a21 * a32 - a22 * a31;
    let b10 = a21 * a33 - a23 * a31;
    let b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    let det = if det != 0.0 { det } else { 1e-12 };
    [
        a11 * b11 - a12 * b10 + a13 * b09,
        a02 * b10 - a01 * b11 - a03 * b09,
        a31 * b05 - a32 * b04 + a33 * b03,
        a22 * b04 - a21 * b05 - a23 * b03,
        a12 * b08 - a10 * b11 - a13 * b07,
        a00 * b11 - a02 * b08 + a03 * b07,
        a32 * b02 - a30 * b05 - a33 * b01,
        a20 * b05 - a22 * b02 + a23 * b01,
        a10 * b10 - a11 * b08 + a13 * b06,
        a01 * b08 - a00 * b10 - a03 * b06,
        a30 * b04 - a31 * b02 + a33 * b00,
        a21 * b02 - a20 * b04 - a23 * b00,
        a11 * b07 - a10 * b09 - a12 * b06,
        a00 * b09 - a01 * b07 + a02 * b06,
        a31 * b01 - a30 * b03 - a32 * b00,
        a20 * b03 - a21 * b01 + a22 * b00,
    ]
    .map(|v| v / det)
}

fn f32s(m: &M4) -> [f32; 16] {
    m.map(|v| v as f32)
}

/// Kinect camera frame (mm, x right, y down) -> room (m): the room matrix after the world flip.
fn kinect_to_room(m: &[f32; 16], x_sign: f32) -> [f32; 16] {
    let mut k = [0.0; 16];
    for r in 0..4 {
        k[r] = m[r] * x_sign * 0.001;
        k[4 + r] = -m[4 + r] * 0.001;
        k[8 + r] = m[8 + r] * 0.001;
        k[12 + r] = m[12 + r];
    }
    k
}

/// room point -> LED pixels, None behind the camera
fn project(vp: &[f32; 16], p: [f32; 3], w: f32, h: f32) -> Option<[f32; 2]> {
    let (m, p) = (vp.map(f64::from), p.map(f64::from));
    let x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    let y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    let cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if cw < 0.05 {
        return None;
    }
    Some([(((x / cw) * 0.5 + 0.5) * f64::from(w)) as f32, ((0.5 - (y / cw) * 0.5) * f64::from(h)) as f32])
}

/// toWorld(): camera frame (mm, y down) -> world (m, x·xSign, y up)
fn to_world(p: [f64; 3], x_sign: f32) -> Vec3 {
    Vec3::new(x_sign * p[0] as f32 / 1000.0, -p[1] as f32 / 1000.0, p[2] as f32 / 1000.0)
}

/// The yaw and pitch of ctx.camera nobody touched (camera.js: auto orbit from the page's start).
fn orbit_angles(now_ms: f64) -> (f64, f64) {
    (32.0 * (2.0 * std::f64::consts::PI * now_ms / 28_000.0).sin(), 14.0)
}

/// params.fx of the depth camera (the hub's camera params; the core keeps only the ray table): the
/// slope of the rays at the image center, 365.5 (the browser's fallback) without one.
fn focal_of_rays(rays: &[f32]) -> f32 {
    let i = (212 * 512 + 256) * 2;
    match (rays.get(i), rays.get(i + 2)) {
        (Some(a), Some(b)) if b - a > 1e-5 => 1.0 / (b - a),
        _ => 365.5,
    }
}

// ---------- the scene ----------

/// A ring of light under a person: fades in and out, follows the person.
struct Ring {
    id: u32,
    x: f32,
    z: f32,
    alpha: f32,
    slot: u8,
    seen: f32,
}

struct Camera {
    vp: [f32; 16],
    inv: [f32; 16],
    eye: [f32; 3],
    focal_px: f32,
}

/// Size-dependent textures and their bind groups.
struct Targets {
    w: u32,
    h: u32,
    hw: u32,
    hh: u32,
    acc: wgpu::TextureView,
    refl: wgpu::TextureView,
    refl2: wgpu::TextureView,
    q1: wgpu::TextureView,
    q2: wgpu::TextureView,
    down: wgpu::BindGroup,
    glow_h: wgpu::BindGroup,
    glow_v: wgpu::BindGroup,
    refl_h: wgpu::BindGroup,
    refl_v: wgpu::BindGroup,
    room: wgpu::BindGroup,
}

struct NeonRoom {
    gpu: Gpu,
    points: wgpu::RenderPipeline,
    down: wgpu::RenderPipeline,
    blur: wgpu::RenderPipeline,
    room: wgpu::RenderPipeline,
    glow_layout: wgpu::BindGroupLayout,
    room_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    point_bufs: [wgpu::Buffer; 2],
    point_groups: [wgpu::BindGroup; 2],
    room_buf: wgpu::Buffer,
    /// blur directions: down (factor 4), horizontal, vertical
    dir_bufs: [wgpu::Buffer; 3],
    targets: Targets,
    tags: tags::Tags,
    rings: Vec<Ring>,
    /// the place the camera looks at (room x, z)
    stage: [f32; 2],
    /// the floor height without a visible floor (under the lowest person)
    fallback: Option<f32>,
    fx: f32,
    pf: [f32; POINT_FLOATS],
    rf: [f32; ROOM_FLOATS],
    colors: [f32; 68],
}

fn fullscreen(gpu: &Gpu, key: &str, module: &wgpu::ShaderModule, entry: &str, format: wgpu::TextureFormat, bgl: &wgpu::BindGroupLayout) -> Result<wgpu::RenderPipeline, String> {
    let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(key), bind_group_layouts: &[Some(bgl)], immediate_size: 0 });
    gpu.render_pipeline(key, |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(key),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module, entry_point: Some("vsFull"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    })
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let gpu = &ctx.gpu;
    let kg = &ctx.kgpu;
    let (v, f) = (wgpu::ShaderStages::VERTEX, wgpu::ShaderStages::FRAGMENT);
    let point_layout = gpu.bind_group_layout(
        "neon-room points",
        &[layout::uniform(0, v | f), layout::storage(1, v, true), layout::storage(2, v, true), layout::storage(3, v, true), layout::storage(4, v, true), layout::storage(5, v, true)],
    );
    let glow_layout = gpu.bind_group_layout("neon-room glow", &[layout::float_tex(0, f, true), layout::sampler(1, f, true), layout::uniform(2, f)]);
    let room_layout = gpu.bind_group_layout(
        "neon-room room",
        &[layout::uniform(0, f), layout::float_tex(1, f, true), layout::float_tex(2, f, true), layout::float_tex(3, f, true), layout::sampler(4, f, true)],
    );
    let points_module = gpu.shader("neon-room points.wgsl", POINTS_WGSL)?;
    let glow_module = gpu.shader("neon-room glow.wgsl", GLOW_WGSL)?;
    let room_module = gpu.shader("neon-room room.wgsl", ROOM_WGSL)?;
    let additive = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
    let ppl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("neon-room points"), bind_group_layouts: &[Some(&point_layout)], immediate_size: 0 });
    let points = gpu.render_pipeline("neon-room points", |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("neon-room points"),
            layout: Some(&ppl),
            vertex: wgpu::VertexState { module: &points_module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &points_module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: HDR, blend: Some(wgpu::BlendState { color: additive, alpha: additive }), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    })?;
    let down = fullscreen(gpu, "neon-room down", &glow_module, "fsDown", HDR, &glow_layout)?;
    let blur = fullscreen(gpu, "neon-room blur", &glow_module, "fsBlur", HDR, &glow_layout)?;
    let room = fullscreen(gpu, "neon-room room", &room_module, "fsRoom", TARGET_FORMAT, &room_layout)?;

    let point_bufs = [gpu.uniform_buffer("neon-room points 0", (POINT_FLOATS * 4) as u64), gpu.uniform_buffer("neon-room points 1", (POINT_FLOATS * 4) as u64)];
    let room_buf = gpu.uniform_buffer("neon-room room", (ROOM_FLOATS * 4) as u64);
    let dir_bufs = [[0.0_f32, 0.0, 4.0, 0.0], [1.5, 0.0, 1.0, 0.0], [0.0, 1.5, 1.0, 0.0]].map(|d| {
        let b = gpu.uniform_buffer("neon-room dir", 16);
        gpu.queue.write_buffer(&b, 0, bytemuck::cast_slice(&d));
        b
    });
    let (index, pdepth, plabel, lut, ir) = (kg.person_index_buffer(), kg.person_depth_buffer(), kg.person_label_buffer(), kg.lut_buffer(), kg.ir_buffer());
    let point_groups = [0, 1].map(|i| {
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("neon-room points"),
            layout: &point_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: point_bufs[i].as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: index.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: pdepth.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: plabel.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: lut.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: ir.as_entire_binding() },
            ],
        })
    });
    let sampler = gpu.linear_sampler();
    let targets = make_targets(gpu, &glow_layout, &room_layout, &sampler, &dir_bufs, &room_buf, ctx.width, ctx.height);
    let mut colors = [0.0_f32; 68];
    for (i, c) in PERSON_COLORS.iter().enumerate() {
        let [r, g, b] = hex_rgb(c);
        colors[i * 4..i * 4 + 4].copy_from_slice(&[r, g, b, 1.0]);
    }
    let tags = tags::Tags::new(gpu)?;
    Ok(Box::new(NeonRoom {
        gpu: gpu.clone(),
        points,
        down,
        blur,
        room,
        glow_layout,
        room_layout,
        sampler,
        point_bufs,
        point_groups,
        room_buf,
        dir_bufs,
        targets,
        tags,
        rings: Vec::new(),
        stage: [0.0, 2.6],
        fallback: None,
        fx: 365.5,
        pf: [0.0; POINT_FLOATS],
        rf: [0.0; ROOM_FLOATS],
        colors,
    }))
}

#[allow(clippy::too_many_arguments)]
fn make_targets(
    gpu: &Gpu,
    glow_layout: &wgpu::BindGroupLayout,
    room_layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    dirs: &[wgpu::Buffer; 3],
    room_buf: &wgpu::Buffer,
    w: u32,
    h: u32,
) -> Targets {
    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
    let tex = |label: &str, tw: u32, th: u32| gpu.texture(label, tw.max(1), th.max(1), HDR, usage).create_view(&Default::default());
    let (hw, hh) = (w.div_ceil(2), h.div_ceil(2));
    let acc = tex("neon-room acc", w, h);
    let refl = tex("neon-room refl", hw, hh);
    let refl2 = tex("neon-room refl2", hw, hh);
    let q1 = tex("neon-room q1", w.div_ceil(4), h.div_ceil(4));
    let q2 = tex("neon-room q2", w.div_ceil(4), h.div_ceil(4));
    let glow_group = |src: &wgpu::TextureView, dir: &wgpu::Buffer| {
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("neon-room glow"),
            layout: glow_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: dir.as_entire_binding() },
            ],
        })
    };
    let room = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("neon-room room"),
        layout: room_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: room_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&acc) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&q1) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&refl) },
            wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(sampler) },
        ],
    });
    Targets {
        w,
        h,
        hw,
        hh,
        down: glow_group(&acc, &dirs[0]),
        glow_h: glow_group(&q1, &dirs[1]),
        glow_v: glow_group(&q2, &dirs[2]),
        refl_h: glow_group(&refl, &dirs[1]),
        refl_v: glow_group(&refl2, &dirs[2]),
        room,
        acc,
        refl,
        refl2,
        q1,
        q2,
    }
}

/// One fullscreen triangle into `view`.
fn full(enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, pipeline: &wgpu::RenderPipeline, group: &wgpu::BindGroup) {
    let mut pass = begin_pass(enc, "neon-room", view);
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.draw(0..3, 0..1);
}

impl NeonRoom {
    /// Per frame: the floor (room frame), the rings, where the camera looks.
    fn update_room(&mut self, ctx: &FrameCtx, list: &[RawPerson]) -> RoomFrame {
        let floor = ctx.kinect.persons.as_ref().and_then(|p| p.floor.as_ref());
        if floor.is_none() {
            // no floor in view: the sensor counts as level, the floor goes under the lowest person
            let mut lowest = 0.0_f32;
            for q in list.iter().filter(|q| q.visible) {
                if let Some(g) = RawPerson::pt3(&q.ground) {
                    lowest = lowest.max(g[1] as f32 / 1000.0);
                }
            }
            if lowest > 0.15 {
                self.fallback = Some(self.fallback.map_or(lowest, |f| f + 0.04 * (lowest - f)));
            }
        }
        let frame = room_frame(floor, ctx.x_sign, self.fallback.unwrap_or_else(|| ctx.params.f("sensorHeight")));
        let now = ctx.time;
        // rings: fade in and out, follow the person
        let (mut cx, mut cz, mut n) = (0.0_f32, 0.0_f32, 0u32);
        for q in list {
            let Some(gp) = RawPerson::pt3(&q.ground) else { continue };
            let g = frame.apply(to_world(gp, ctx.x_sign));
            let i = match self.rings.iter().position(|r| r.id == q.id) {
                Some(i) => i,
                None => {
                    self.rings.push(Ring { id: q.id, x: g.x, z: g.z, alpha: 0.0, slot: q.slot, seen: now });
                    self.rings.len() - 1
                }
            };
            let Some(r) = self.rings.get_mut(i) else { continue };
            r.x += 0.5 * (g.x - r.x);
            r.z += 0.5 * (g.z - r.z);
            r.slot = q.slot;
            if q.visible {
                r.seen = now;
                cx += g.x;
                cz += g.z;
                n += 1;
            }
        }
        let dt = ctx.dt;
        self.rings.retain_mut(|r| {
            let alive = now - r.seen < 0.05 && list.iter().any(|q| q.id == r.id);
            r.alpha = (r.alpha + if alive { dt / 0.35 } else { -dt / 0.7 }).clamp(0.0, 1.0);
            !(r.alpha <= 0.0 && !alive)
        });
        // the camera looks at the people (or at the middle of the field of view)
        let target = if n > 0 { [cx / n as f32, cz / n as f32] } else { [0.0, 2.6] };
        let k = (dt * if n > 0 { 1.2 } else { 0.4 }).min(1.0);
        self.stage[0] += k * (target[0] - self.stage[0]);
        self.stage[1] += k * (target[1] - self.stage[1]);
        frame
    }

    fn camera(&self, ctx: &FrameCtx) -> Camera {
        let p = ctx.params;
        // ctx.camera: its zoom, the pitch and yaw of its automatic orbit (nobody drags on the wall)
        let (yaw_deg, pitch_deg) = orbit_angles(ctx.now_ms);
        let yaw = yaw_deg * DEG;
        let pitch = pitch_deg.clamp(-3.0, 65.0) * DEG;
        let dist = p.f64("distance") * ZOOM / 1.6;
        let target = [f64::from(self.stage[0]), p.f64("lookHeight"), f64::from(self.stage[1])];
        let eye = [target[0] + dist * yaw.sin() * pitch.cos(), (target[1] + dist * pitch.sin()).max(0.12), target[2] - dist * yaw.cos() * pitch.cos()];
        let aspect = f64::from(ctx.width) / f64::from(ctx.height.max(1));
        let fov = p.f64("fov");
        let vp = mul(&perspective(fov, aspect, 0.05, 400.0), &look_at(eye, target));
        let vp32 = f32s(&vp);
        Camera {
            inv: f32s(&invert(&vp32.map(f64::from))),
            vp: vp32,
            eye: eye.map(|v| v as f32),
            focal_px: (f64::from(ctx.height) / 2.0 / ((fov * DEG) / 2.0).tan()) as f32,
        }
    }
}

impl Scene for NeonRoom {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let p = ctx.params;
        let (w, h) = (ctx.width.max(1), ctx.height.max(1));
        if self.targets.w != w || self.targets.h != h {
            self.targets = make_targets(&self.gpu, &self.glow_layout, &self.room_layout, &self.sampler, &self.dir_bufs, &self.room_buf, w, h);
        }
        if ctx.kinect.fresh.lut || ctx.frame == 0 {
            self.fx = focal_of_rays(&ctx.kinect.rays());
        }
        let persons = ctx.kinect.persons.clone();
        let list: &[RawPerson] = persons.as_ref().map_or(&[], |r| r.list.as_slice());
        let count = persons.as_ref().map_or(0, |r| r.count);
        let frame = self.update_room(ctx, list);
        let cam = self.camera(ctx);
        let kin = kinect_to_room(&frame.matrix, ctx.x_sign);
        let scan_h = if p.b("scan") { ((ctx.time * 0.42) % 3.2) - 0.4 } else { -1.0 };
        // key light from above, slightly from the front (the side of the sensor) and the left
        let light = Vec3::new(-0.35, 0.8, -0.48).normalize();
        let t = &self.targets;
        let reflection = p.f("reflection");
        for mirror in 0..2 {
            let m = mirror == 1;
            let (tw, th) = if m { (t.hw as f32, t.hh as f32) } else { (t.w as f32, t.h as f32) };
            let pf = &mut self.pf;
            pf[0..16].copy_from_slice(&cam.vp);
            pf[16..32].copy_from_slice(&kin);
            pf[32..36].copy_from_slice(&[cam.eye[0], cam.eye[1], cam.eye[2], ctx.time]);
            pf[36..40].copy_from_slice(&[tw, th, 1.0 / tw, 1.0 / th]);
            pf[40..44].copy_from_slice(&[p.f("dotFill") * if m { 1.3 } else { 1.0 }, self.fx, cam.focal_px * if m { 0.5 } else { 1.0 }, if m { 1.0 } else { 0.0 }]);
            pf[44..48].copy_from_slice(&[p.f("gain"), p.f("irDetail"), scan_h, 0.06]);
            pf[48..52].copy_from_slice(&[reflection, 2.0, p.f("whiteMix"), p.f("rim")]);
            pf[52..56].copy_from_slice(&[light.x, light.y, light.z, 0.28]);
            pf[56..124].copy_from_slice(&self.colors);
            ctx.gpu.queue.write_buffer(&self.point_bufs[mirror], 0, bytemuck::cast_slice(&self.pf));
        }
        let rf = &mut self.rf;
        let rgb = |key: &str, a: f32| {
            let c = p.color(key);
            [c[0], c[1], c[2], a]
        };
        rf[0..16].copy_from_slice(&cam.inv);
        rf[16..20].copy_from_slice(&[cam.eye[0], cam.eye[1], cam.eye[2], ctx.time]);
        rf[20..24].copy_from_slice(&[t.w as f32, t.h as f32, 1.0 / t.w as f32, 1.0 / t.h as f32]);
        rf[24..28].copy_from_slice(&rgb("gridColor", p.f("grid")));
        rf[28..32].copy_from_slice(&rgb("horizonColor", p.f("horizon")));
        rf[32..36].copy_from_slice(&rgb("skyColor", 1.0));
        rf[36..40].copy_from_slice(&rgb("floorColor", if reflection > 0.0 { 1.0 } else { 0.0 }));
        rf[40..44].copy_from_slice(&[p.f("gain"), p.f("glow"), 0.55, p.f("fovLines")]);
        rf[44..48].copy_from_slice(&[0.0, 0.0, 0.0, (35.0 * DEG) as f32]);
        rf[48..52].copy_from_slice(&[4.5, 0.42, p.f("gridSize"), p.f("rings")]);
        let mut slots = self.rings.iter().filter(|r| r.alpha > 0.0).take(MAX_PERSONS);
        for k in 0..16 {
            let v = slots.next().map_or([0.0; 4], |r| [r.x, r.z, r.alpha, f32::from(r.slot)]);
            rf[52 + k * 4..56 + k * 4].copy_from_slice(&v);
        }
        rf[116..184].copy_from_slice(&self.colors);
        ctx.gpu.queue.write_buffer(&self.room_buf, 0, bytemuck::cast_slice(&self.rf));

        let enc = &mut *ctx.encoder;
        {
            let mut rp = begin_pass(enc, "neon-room points", &t.acc);
            if count > 0 {
                rp.set_pipeline(&self.points);
                rp.set_bind_group(0, &self.point_groups[0], &[]);
                rp.draw(0..6, 0..count as u32);
            }
        }
        {
            let mut rp = begin_pass(enc, "neon-room reflection", &t.refl);
            if count > 0 && reflection > 0.0 {
                rp.set_pipeline(&self.points);
                rp.set_bind_group(0, &self.point_groups[1], &[]);
                rp.draw(0..6, 0..count as u32);
            }
        }
        if reflection > 0.0 {
            full(enc, &t.refl2, &self.blur, &t.refl_h);
            full(enc, &t.refl, &self.blur, &t.refl_v);
        }
        full(enc, &t.q1, &self.down, &t.down);
        full(enc, &t.q2, &self.blur, &t.glow_h);
        full(enc, &t.q1, &self.blur, &t.glow_v);
        full(enc, ctx.target, &self.room, &t.room);

        if p.b("labels") {
            let (sw, sh) = (w as f32, h as f32);
            self.tags.begin();
            for q in list.iter().filter(|q| q.visible) {
                let Some(hp) = RawPerson::pt3(&q.head) else { continue };
                let head = frame.apply(to_world(hp, ctx.x_sign));
                let Some(s) = project(&cam.vp, [head.x, head.y + 0.28, head.z], sw, sh) else { continue };
                self.tags.add(q.id, q.slot, q.height.get(), s);
            }
            self.tags.render(ctx.gpu, enc, ctx.target, [w, h]);
        }

        let floor = match persons.as_ref().and_then(|r| r.floor.as_ref()) {
            Some(f) => format!("Boden {:.2} m{}", f.height.get(), if f.source.as_deref() == Some("feet") { " (aus Füßen)" } else { "" }),
            None => "kein Boden sichtbar".to_string(),
        };
        *ctx.status = format!("{}k Punkte · {floor}", (count as f64 / 1000.0).round());
        Ok(())
    }
}

pub static DEF: SceneDef = SceneDef {
    name: "neon-room",
    title: "Neon-Raum",
    params,
    projection: no_projection,
    persons: exact,
    streams,
    max_fps: no_cap,
    make,
};

wall::export_scenes!(&DEF);
