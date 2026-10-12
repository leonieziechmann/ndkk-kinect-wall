//! Fluid-Simulation (port of web/scenes/fluid-simulation): fluid on the LED wall, stirred by the
//! people in front of it, one dye texel per LED. Where people land on the wall comes from the shared
//! wall setup and the scene's projection: mirrored, the walk stretched over the whole wall, the body
//! in real size.
//! Built on the person tracking (live by default): only the people's pixels count. Their motion is
//! measured on the masks (exact in every frame): an optical flow of the people's camera image,
//! turned into meters per second with the depth, put into the room and through the wall mapping (a
//! stretched walk moves along). Where a person stands and how fast they move counts in meters:
//! standing closer to the sensor gives no more influence, standing still shows nothing. The skeleton
//! says which pixels are arms: they count more and reach further. Dye goes only on the people's image
//! on the wall, swept along their motion: what moves keeps a sharp outline. It is colored by distance
//! by default. The mouse splats of the browser's preview page stay off (no pointer on the wall).
//!
//! The browser scene's own WGSL runs unchanged (res.rs):
//!   prep -> camSignal -> down, down -> lkCoarse -> lkRefine -> lkFinal   optical flow, 3 levels
//!   bodyScatter, bodyImage, bodyClear                                   the people on the wall, per LED
//!   nearest, scene, vcollect                                            3D motion -> wall cells
//!   wallMotion                                                          smoothing on the wall
//! once per person tracking result; per render frame: dyeStats, force, dye, curl, vorticity,
//! divergence, pressure (Jacobi), gradient, advection (dye: MacCormack), display.

mod res;

use std::fmt::Write as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use serde_json::json;

use wall::params::{ParamSpec, Params, boolean, color, num, select_map};
use wall::persons::{NPOINTS, PersonOptions};
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, cap30, no_streams};

use res::{Cam, FIELDS, GRID_ROWS, Pipes, SKEL_FLOATS, SKEL_PERSONS, Size, UNIFORM_FLOATS, WallRes};

fn params() -> Vec<ParamSpec> {
    vec![
        // Bewegung
        boolean("live", true, "Live (weniger Verzögerung)"),
        num("force", 10.0, 0.0, 40.0, 0.5, "Mitnahme"),
        num("flowGain", 1.5, 0.2, 5.0, 0.05, "Verstärkung"),
        num("threshold", 0.3, 0.0, 3.0, 0.05, "Schwelle (m/s)"),
        num("armGain", 2.0, 1.0, 5.0, 0.1, "Arme verstärken"),
        num("armBrush", 0.25, 0.0, 0.6, 0.01, "Arm-Reichweite (m)"),
        num("coherence", 0.5, 0.0, 0.95, 0.01, "Richtungstreue"),
        num("flowSmooth", 0.4, 0.0, 0.9, 0.01, "Glättung"),
        num("denoise", 8.0, 0.1, 30.0, 0.1, "Rauschfilter"),
        boolean("balanceOn", true, "Automatisch ausgleichen"),
        num("fillTarget", 0.3, 0.05, 0.8, 0.01, "Füllung (Ziel)"),
        num("irMix", 0.3, 0.0, 1.0, 0.01, "IR-Anteil (Farbe)"),
        num("grow", 0.4, 0.0, 1.0, 0.01, "Formen aufweiten"),
        // Fluid
        num("curl", 20.0, 0.0, 80.0, 1.0, "Wirbel"),
        num("velDiss", 0.3, 0.0, 4.0, 0.05, "Bremsen"),
        num("dyeDiss", 0.5, 0.0, 4.0, 0.05, "Verblassen"),
        num("fade", 0.06, 0.0, 0.5, 0.01, "Ausklingen"),
        num("pressureIters", 24.0, 4.0, 60.0, 1.0, "Druck-Iterationen"),
        num("pressureDecay", 0.8, 0.0, 1.0, 0.01, "Druck halten"),
        select_map("simRes", json!(168), &[("84", json!(84)), ("112", json!(112)), ("168", json!(168)), ("224", json!(224))], "Auflösung Strömung"),
        // colors
        select_map("colorMode", json!(0), &[("Tiefe", json!(0)), ("Person", json!(1)), ("Neon", json!(2)), ("Regenbogen", json!(3)), ("Einfarbig", json!(4))], "Farben"),
        color("tint", "#4fb4ff", "Einfarbig"),
        num("hueSpeed", 0.04, -0.5, 0.5, 0.01, "Farbdrift"),
        num("hueBySpeed", 0.2, 0.0, 0.5, 0.01, "Farbe nach Tempo"),
        num("personHue", 0.3, 0.0, 0.5, 0.01, "Farbe je Person"),
        num("dyeAmount", 2.0, 0.0, 4.0, 0.05, "Farbmenge"),
        num("exposure", 1.8, 0.2, 5.0, 0.05, "Helligkeit"),
        num("shading", 0.5, 0.0, 1.0, 0.01, "Relief"),
        num("splatRadius", 0.03, 0.005, 0.2, 0.005, "Maus-Radius"),
        // Prüfen
        boolean("showPeople", false, "Personen + 1-m-Raster"),
        boolean("showSkeleton", false, "Skelette zeigen"),
        boolean("showFlow", false, "Fluss zeigen"),
    ]
}

fn persons(p: &Params) -> Option<PersonOptions> {
    Some(if p.b("live") { PersonOptions::live() } else { PersonOptions::exact() })
}

/// IEEE half float (u16) -> number
fn half(x: u16) -> f32 {
    let e = i32::from((x >> 10) & 31);
    let f = f32::from(x & 1023);
    let v = if e != 0 { (1.0 + f / 1024.0) * 2f32.powi(e - 15) } else { f / 1024.0 * 2f32.powi(-14) };
    if x & 0x8000 != 0 { -v } else { v }
}

/// The 1x1 stats texture on its way back to the CPU.
#[derive(Clone, Copy, PartialEq)]
enum Read {
    Idle,
    /// copied in the last frame's commands
    Copied,
    /// map_async running
    Mapping,
}

struct FluidSimulation {
    pipes: Pipes,
    cam: Cam,
    r: WallRes,
    uni: [f32; UNIFORM_FLOATS],
    skel: Vec<f32>,
    /// the pressure texture read next
    pres: usize,
    last_seq: Option<u32>,
    /// ctx.time of the last tracking result, -1 before the first
    last_persons: f32,
    // fill and balance gain for the status line, read back from the GPU twice a second
    readback: wgpu::Buffer,
    read: Read,
    mapped: Arc<AtomicU8>,
    last_read: f32,
    fill: f32,
    gain: f32,
}

impl FluidSimulation {
    /// (Re)creates everything whose size depends on the wall setup or params (main.js ensure()).
    fn ensure(&mut self, ctx: &FrameCtx) -> Result<(), String> {
        let size = Size::new([ctx.width, ctx.height], ctx.wall.size(), ctx.params.f64("simRes"));
        if size != self.r.size {
            self.r = WallRes::new(ctx.gpu, &self.pipes, &self.cam, size)?;
            self.pres = 0;
        }
        Ok(())
    }

    fn write_uniforms(&mut self, ctx: &FrameCtx, dt: f32, frame_step: f32, motion_on: bool) {
        let p = ctx.params;
        let s = self.r.size;
        let tint = p.color("tint");
        let flag = |on: bool| if on { 1.0 } else { 0.0 };
        for (u, f) in self.uni.iter_mut().zip(FIELDS) {
            let v = match f {
                "simW" => s.sim_w as f32,
                "simH" => s.sim_h as f32,
                "dyeW" => s.led_w as f32,
                "dyeH" => s.led_h as f32,
                "gridW" => s.grid_w as f32,
                "gridH" => GRID_ROWS as f32,
                // no pointer on the LED wall: as if it were never inside
                "mouseX" | "mouseY" | "mouseDX" | "mouseDY" | "mouseDown" => 0.0,
                "dt" => dt,
                "time" => ctx.time,
                "motionOn" => flag(motion_on),
                "frameStep" => frame_step,
                "lambda" => p.f("denoise") * 0.001,
                "showPeople" | "showSkeleton" | "showFlow" | "balanceOn" => flag(p.b(f)),
                "tintR" => tint[0],
                "tintG" => tint[1],
                "tintB" => tint[2],
                _ => p.f(f),
            };
            *u = if v.is_nan() { 0.0 } else { v };
        }
        ctx.gpu.queue.write_buffer(&self.pipes.uniform, 0, bytemuck::cast_slice(&self.uni));
    }

    /// Every visible person's joints (room m, the room of the wall setup) and color. Where each
    /// person lands on the wall (shift, shift rate) is in WALL.slots, from the runtime.
    fn write_skeletons(&mut self, ctx: &FrameCtx) {
        let d = &mut self.skel;
        d.fill(0.0);
        for person in &*ctx.kinect.view {
            let s = usize::from(person.slot);
            if !(1..=16).contains(&s) {
                continue;
            }
            for (j, (w, conf)) in person.joints.iter().zip(person.confidence).enumerate().take(NPOINTS) {
                let Some(w) = w else { continue };
                let r = ctx.wall.to_room(*w);
                let o = (s * NPOINTS + j) * 4;
                if let Some(dst) = d.get_mut(o..o + 4) {
                    dst.copy_from_slice(&[r.x, r.y, r.z, conf.max(0.01)]);
                }
            }
            let o = (SKEL_PERSONS + s) * 4;
            if let Some(dst) = d.get_mut(o..o + 4) {
                dst.copy_from_slice(&[person.color[0], person.color[1], person.color[2], 1.0]);
            }
        }
        ctx.gpu.queue.write_buffer(&self.pipes.skel, 0, bytemuck::cast_slice(d));
    }

    /// Twice a second the stats texture goes back to the CPU for the status line, without waiting:
    /// copied in one frame, mapped in the next (after the runtime submitted the copy), read when ready.
    fn readback(&mut self, ctx: &mut FrameCtx) {
        match self.read {
            Read::Idle => {
                if ctx.time - self.last_read > 0.5 {
                    let layout = wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: None };
                    let one = wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 };
                    ctx.encoder.copy_texture_to_buffer(self.r.stats.tex.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &self.readback, layout }, one);
                    self.read = Read::Copied;
                    self.last_read = ctx.time;
                }
            }
            Read::Copied => {
                let state = self.mapped.clone();
                state.store(0, Ordering::Release);
                self.readback.slice(..).map_async(wgpu::MapMode::Read, move |r| state.store(if r.is_ok() { 1 } else { 2 }, Ordering::Release));
                self.read = Read::Mapping;
            }
            Read::Mapping => match self.mapped.load(Ordering::Acquire) {
                0 => {
                    let _ = ctx.gpu.device.poll(wgpu::PollType::Poll);
                }
                1 => {
                    if let Ok(data) = self.readback.slice(0..8).get_mapped_range() {
                        let h = |i: usize| u16::from_le_bytes([data.get(i).copied().unwrap_or(0), data.get(i + 1).copied().unwrap_or(0)]);
                        self.fill = half(h(0));
                        self.gain = half(h(2));
                    }
                    self.readback.unmap();
                    self.read = Read::Idle;
                }
                _ => self.read = Read::Idle,
            },
        }
    }

    fn status(&self, ctx: &mut FrameCtx) {
        let wall = &*ctx.wall;
        let s = &mut *ctx.status;
        s.clear();
        let _ = write!(s, "{} Person(en) · ", ctx.kinect.view.len());
        let _ = if wall.room_found { write!(s, "Boden: Kinect {:.2} m hoch", wall.room_height) } else { write!(s, "kein Boden erkannt: Kinect {:.2} m (Wand-Setup)", wall.room_height) };
        if ctx.params.b("balanceOn") {
            let gain = if self.gain != 0.0 && !self.gain.is_nan() { self.gain } else { 1.0 };
            let _ = write!(s, " · Füllung {} % · Ausgleich ×{gain:.2}", (self.fill * 100.0).round());
        }
    }
}

impl Scene for FluidSimulation {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        self.ensure(ctx)?;
        let dt = ctx.dt.clamp(0.001, 1.0 / 20.0);
        let seq = ctx.kinect.persons.as_ref().map(|r| r.seq);
        let fresh = ctx.kinect.fresh.persons && seq.is_some();
        // frames since the last result (normally 1): the optical flow measures over all of them
        let mut frame_step = 1.0;
        if fresh {
            self.last_persons = ctx.time;
            if let (Some(last), Some(seq)) = (self.last_seq, seq) {
                frame_step = (i64::from(seq) - i64::from(last)).clamp(1, 3) as f32;
            }
            self.last_seq = seq;
        }
        let motion_on = self.last_persons >= 0.0 && ctx.time - self.last_persons < 0.5;
        self.write_uniforms(ctx, dt, frame_step, motion_on);
        if fresh {
            self.write_skeletons(ctx);
        }

        let r = &self.r;
        let mut pass = ctx.encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("fluid-simulation"), timestamp_writes: None });
        // how full the wall is (from the last frame's dye): steers the balance of this frame
        r.stats_step.run(&mut pass);
        // the people -> the wall, once per person tracking result (masks and skeletons of one frame)
        if fresh {
            for s in &r.fresh {
                s.run(&mut pass);
            }
        }
        // forces and dye from the motion, vorticity confinement, projection
        for s in &r.fluid {
            s.run(&mut pass);
        }
        r.pressure_fade[self.pres].run(&mut pass);
        self.pres ^= 1;
        // (the bound only guards against broken show entries: the slider stops at 60)
        let iters = ctx.params.f64("pressureIters").round().clamp(0.0, 1000.0) as u32;
        for _ in 0..iters {
            r.jacobi[self.pres].run(&mut pass);
            self.pres ^= 1;
        }
        r.gradient[self.pres].run(&mut pass);
        for s in &r.advect {
            s.run(&mut pass);
        }
        drop(pass);
        // what this round computed is the next round's "before"
        r.stats.copy_to(ctx.encoder, &r.stats_prev);
        if fresh {
            self.cam.sig.copy_to(ctx.encoder, &self.cam.sig_prev);
            self.cam.flow.copy_to(ctx.encoder, &self.cam.flow_prev);
        }

        let mut rp = wall::gpu::begin_pass(ctx.encoder, "fluid-simulation display", ctx.target);
        rp.set_pipeline(&self.pipes.display);
        rp.set_bind_group(0, &r.display, &[]);
        rp.draw(0..3, 0..1);
        drop(rp);

        self.readback(ctx);
        self.status(ctx);
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let pipes = Pipes::new(&ctx.gpu, &ctx.kgpu, &ctx.wall_buf)?;
    let cam = Cam::new(&ctx.gpu);
    let size = Size::new([ctx.width, ctx.height], ctx.wall.size(), ctx.params.f64("simRes"));
    let r = WallRes::new(&ctx.gpu, &pipes, &cam, size)?;
    let readback = ctx.gpu.buffer("fluid-simulation readback", 256, wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ);
    Ok(Box::new(FluidSimulation {
        pipes,
        cam,
        r,
        uni: [0.0; UNIFORM_FLOATS],
        skel: vec![0.0; SKEL_FLOATS],
        pres: 0,
        last_seq: None,
        last_persons: -1.0,
        readback,
        read: Read::Idle,
        mapped: Arc::new(AtomicU8::new(0)),
        last_read: 0.0,
        fill: 0.0,
        gain: 1.0,
    }))
}

pub static DEF: SceneDef = SceneDef {
    name: "fluid-simulation",
    title: "Fluid-Simulation",
    params,
    // the whole wall can be reached, yet one stands roughly where one shows: a trapezoid between the
    // view cone and a box (1.8 m wide 0.8 m from the sensor, 5 m at 4 m: from about 2.5 m on the edges
    // of the view reach the wall's edges; in front the middle 4 m), a curve that keeps the middle calm
    // (×1.1-1.5 at 2-3 m) and moves faster towards the edges, a little smoothing
    projection: || {
        json!({
            "field": { "depth": [0.8, 4], "width": [1.8, 5] },
            "curve.x": [[0.25, 0.29], [0.75, 0.71]],
            "edge": "clamp",
            "margin": 0.2,
            "smoothing": 0.2,
        })
    },
    persons,
    // 'persons' brings the depth (the hub's tracking needs no infrared, so none is subscribed)
    streams: no_streams,
    // the person tracking (pose model) and the Kinect's depth decoding share the GPU
    max_fps: cap30,
    make,
};

wall::export_scenes!(&DEF);
