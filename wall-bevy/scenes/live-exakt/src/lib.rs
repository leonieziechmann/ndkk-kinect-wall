//! Live und exakt (web/scenes/live-exakt): what persons { live: true } gives a scene. The live
//! skeletons come at once (colored); the exact ones of every frame follow 100–250 ms later (thin,
//! white, dashed). A raised hand is noticed on the live data at once (yellow ring) and then checked
//! against the exact frames with a LiveCheck: green = confirmed, red = overruled. The status line
//! measures how far the live joints are from the exact ones of the same frame.
//!
//! Drawn as in the browser's Canvas 2D: the silhouettes (a 512 x 424 picture, scaled onto the
//! camera image's place) and the lines and rings on top; the silhouettes are scaled by the GPU,
//! the lines drawn on the CPU into an overlay.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use wall::canvas::{Canvas, Rgba};
use wall::gpu::{FULLSCREEN_WGSL, Gpu, TARGET_FORMAT, layout};
use wall::kinect::KinectData;
use wall::params::{ParamSpec, Params, boolean, num, select};
use wall::persons::{BONES, PersonOptions, PersonsResult, PersonsView, ViewMode, j};
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, no_cap, no_projection, no_streams};

pub static DEF: SceneDef = SceneDef {
    name: "live-exakt",
    title: "Live und exakt",
    params,
    projection: no_projection,
    persons,
    streams: no_streams,
    max_fps: no_cap,
    make,
};

/// m above the head: a hand counts as raised
const UP: f32 = 0.1;
/// m: lowered again (hysteresis)
const DOWN: f32 = 0.0;
const HANDS: [usize; 2] = [j::LEFT_HAND, j::RIGHT_HAND];
/// the 17 COCO joints, neck, pelvis, head, hands (raw camera points)
const COMPARED: usize = 22;
const W: u32 = 512;
const H: u32 = 424;

fn params() -> Vec<ParamSpec> {
    vec![
        boolean("live", true, "Live + exakt (aus: nur verzögert)"),
        select("compare", "jetzt", &["jetzt", "gleiches Frame"], "Exaktes Skelett"),
        select("mode", "Voll", &["Voll", "Skelett"], "Tracker"),
        num("silhouettes", 0.25, 0.0, 1.0, 0.05, "Silhouetten"),
    ]
}

/// { live: p.live, mode: p.mode === 'Skelett' ? 'skeleton' : 'full' }
fn persons(p: &Params) -> Option<PersonOptions> {
    let base = if p.b("live") { PersonOptions::both() } else { PersonOptions::exact() };
    Some(PersonOptions { skeleton: p.s("mode") == "Skelett", ..base })
}

const WGSL: &str = r"
struct U { rect: vec4f, misc: vec4f }; // rect: x0, y0, x1, y1 of the camera image (LED px); misc.x: silhouettes
@group(0) @binding(0) var mask: texture_2d<f32>;
@group(0) @binding(1) var over: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var c = vec3f(0.0);
  let size = u.rect.zw - u.rect.xy;
  if (u.misc.x > 0.0 && abs(size.x) > 0.5 && abs(size.y) > 0.5) {
    // drawImage(mask, ...) into the rect, mirrored where x1 < x0, smoothed, with globalAlpha
    let uv = (pos.xy - u.rect.xy) / size;
    if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
      c = textureSampleLevel(mask, samp, uv, 0.0).rgb * u.misc.x;
    }
  }
  let o = textureLoad(over, vec2i(pos.xy), 0); // premultiplied
  return vec4f(o.rgb + c * (1.0 - o.a), 1.0);
}
";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Verdict {
    /// not settled yet (undefined)
    Open,
    Ok,
    No,
    /// no exact data (null)
    NoData,
}

/// A claim made on the live data: the hand `hand` of person `id` is up in frame `seq`.
struct Claim {
    key: u64,
    id: u32,
    hand: usize,
    seq: u32,
    verdict: Verdict,
}

struct Mark {
    claim: u64,
    x: f32,
    y: f32,
    until: f32,
}

/// LiveCheck of lib/persons.js: claims made on the live data, settled by the exact frames around
/// their frame (before / after), or given up after max_wait_ms.
struct LiveCheck {
    before: i64,
    after: i64,
    max_wait_ms: f64,
    /// claim key, next frame to look at, when it was made (ms)
    pending: Vec<(u64, i64, f64)>,
}

impl LiveCheck {
    fn add(&mut self, view: &PersonsView, claim: &mut Claim, now: f64) {
        claim.seq = view.seq.unwrap_or(0);
        claim.verdict = Verdict::Open;
        self.pending.push((claim.key, i64::from(claim.seq) - self.before, now));
    }

    /// Tests the open claims on the exact frames that came in; returns (key, verdict, waited ms)
    /// of those settled now.
    fn update(&mut self, k: &mut KinectData, claims: &mut [Claim], now: f64, out: &mut Vec<(u64, Verdict, f64)>) {
        let newest = k.exact_view.as_ref().and_then(|v| v.seq).map(i64::from);
        let live_only = k.mode == ViewMode::Live;
        let (after, max_wait) = (self.after, self.max_wait_ms);
        self.pending.retain_mut(|(key, next, at)| {
            let Some(c) = claims.iter_mut().find(|c| c.key == *key) else {
                return false;
            };
            if live_only {
                c.verdict = Verdict::NoData;
            } else {
                let last = newest.map_or(i64::MIN, |n| (i64::from(c.seq) + after).min(n));
                while c.verdict == Verdict::Open && *next <= last {
                    if *next >= 0
                        && let Some(ex) = k.exact_at(*next as u32)
                        && hand_raised(ex.by_id(c.id), c.hand, UP)
                    {
                        c.verdict = Verdict::Ok;
                    }
                    *next += 1;
                }
                if c.verdict == Verdict::Open && newest.is_some_and(|n| n >= i64::from(c.seq) + after) {
                    c.verdict = Verdict::No;
                }
                if c.verdict == Verdict::Open && now - *at > max_wait {
                    c.verdict = Verdict::NoData;
                }
            }
            if c.verdict == Verdict::Open {
                return true;
            }
            out.push((c.key, c.verdict, now - *at));
            false
        });
    }
}

fn hand_raised(p: Option<&wall::persons::Person>, hand: usize, margin: f32) -> bool {
    let Some(p) = p else { return false };
    match (p.joints.get(hand).copied().flatten(), p.joints[j::HEAD]) {
        (Some(h), Some(head)) => h.y > head.y + margin,
        _ => false,
    }
}

/// A raw camera point (mm) of a person entry: joints 0..16, then neck, pelvis, head, hands.
fn raw(c: &wall::persons::RawPerson, k: usize) -> Option<[f32; 3]> {
    let p = if k < 17 { c.joints.get(k) } else { c.extra.get(k - 17) }?;
    (p[3].f() > 0.0).then(|| [p[0].f(), p[1].f(), p[2].f()])
}

fn quantile(a: &VecDeque<f64>, q: f64) -> Option<f64> {
    if a.is_empty() {
        return None;
    }
    let mut s: Vec<f64> = a.iter().copied().collect();
    s.sort_by(f64::total_cmp);
    s.get((q * (s.len() - 1) as f64).floor() as usize).copied()
}

fn push(a: &mut VecDeque<f64>, v: f64, n: usize) {
    a.push_back(v);
    while a.len() > n {
        a.pop_front();
    }
}

struct LiveExakt {
    pipeline: wgpu::RenderPipeline,
    group: wgpu::BindGroup,
    mask_tex: wgpu::Texture,
    over_tex: wgpu::Texture,
    ubuf: wgpu::Buffer,
    gpu: Gpu,
    over: Canvas,
    mask: Vec<u8>,
    /// the tracking result the mask shows (and the colors of its slots)
    mask_of: Option<Arc<PersonsResult>>,
    check: LiveCheck,
    claims: Vec<Claim>,
    next_key: u64,
    /// (id, hand) raised on the live data
    raised: HashSet<(u32, usize)>,
    marks: Vec<Mark>,
    /// recent |live - exact| in cm, all compared points / the hands
    errs: VecDeque<f64>,
    hand_errs: VecDeque<f64>,
    /// exact persons not in the live frame of the same seq
    missing: usize,
    compared: usize,
    ok: usize,
    no: usize,
    none: usize,
    waited: VecDeque<f64>,
    shown: String,
    shown_at: f32,
    settled: Vec<(u64, Verdict, f64)>,
}

fn make(s: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let gpu = s.gpu.clone();
    let m = gpu.shader("live-exakt", &format!("{FULLSCREEN_WGSL}\n{WGSL}"))?;
    let f = wgpu::ShaderStages::FRAGMENT;
    let bgl = gpu.bind_group_layout("live-exakt", &[layout::float_tex(0, f, true), layout::float_tex(1, f, false), layout::sampler(2, f, true), layout::uniform(3, f)]);
    let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("live-exakt"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
    let pipeline = gpu.render_pipeline("live-exakt", |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("live-exakt"),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module: &m, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &m,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: TARGET_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    })?;
    let usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST;
    let mask_tex = gpu.texture("live-exakt mask", W, H, wgpu::TextureFormat::Rgba8Unorm, usage);
    let over_tex = gpu.texture("live-exakt overlay", s.width, s.height, wgpu::TextureFormat::Rgba8Unorm, usage);
    let ubuf = gpu.uniform_buffer("live-exakt", 32);
    let (mv, ov) = (mask_tex.create_view(&Default::default()), over_tex.create_view(&Default::default()));
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("live-exakt"),
        layout: &bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&mv) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&ov) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&gpu.linear_sampler()) },
            wgpu::BindGroupEntry { binding: 3, resource: ubuf.as_entire_binding() },
        ],
    });
    let mask = vec![0u8; (W * H * 4) as usize];
    gpu.write_texture(&mask_tex, &mask, 4);
    Ok(Box::new(LiveExakt {
        pipeline,
        group,
        mask_tex,
        over_tex,
        ubuf,
        gpu,
        over: Canvas::new(s.width, s.height),
        mask,
        mask_of: None,
        check: LiveCheck { before: 2, after: 3, max_wait_ms: 1500.0, pending: Vec::new() },
        claims: Vec::new(),
        next_key: 0,
        raised: HashSet::new(),
        marks: Vec::new(),
        errs: VecDeque::new(),
        hand_errs: VecDeque::new(),
        missing: 0,
        compared: 0,
        ok: 0,
        no: 0,
        none: 0,
        waited: VecDeque::new(),
        shown: String::new(),
        shown_at: f32::NEG_INFINITY,
        settled: Vec::new(),
    }))
}

/// ctx.kinectToScreen(u, v), [-1e4, -1e4] where it has no place (as the browser)
fn to_screen(ctx: &FrameCtx, u: f32, v: f32) -> [f32; 2] {
    ctx.kinect_to_screen(u, v).unwrap_or([-1e4, -1e4])
}

impl LiveExakt {
    /// The live silhouettes of the newest tracking result, colored by slot.
    fn update_mask(&mut self, k: &KinectData) {
        let Some(r) = k.persons.as_ref() else { return };
        if self.mask_of.as_ref().is_some_and(|m| Arc::ptr_eq(m, r)) {
            return;
        }
        self.mask_of = Some(r.clone());
        self.mask.fill(0);
        if let (Some(labels), Some(indices)) = (&r.labels, &r.indices) {
            let mut rgb = [None; 32];
            for p in &k.view.all {
                if let Some(c) = rgb.get_mut(usize::from(p.slot)) {
                    *c = Some(p.color.map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8));
                }
            }
            for &i in indices.iter().take(r.count) {
                let i = i as usize;
                let Some(Some(c)) = labels.get(i).and_then(|l| rgb.get(usize::from(*l))) else { continue };
                if let Some(px) = self.mask.get_mut(i * 4..i * 4 + 4) {
                    px.copy_from_slice(&[c[0], c[1], c[2], 255]);
                }
            }
        }
        self.gpu.write_texture(&self.mask_tex, &self.mask, 4);
    }

    /// The exact frames that came in: how far the live joints of the same frame were from them.
    fn measure(&mut self, k: &mut KinectData) {
        let updates = k.exact_updates.clone();
        for ex in updates {
            let Some(seq) = ex.seq else { continue };
            let Some(lv) = k.live_at(seq) else { continue };
            for p in &*ex {
                self.compared += 1;
                let Some(q) = lv.by_id(p.id) else {
                    self.missing += 1;
                    continue;
                };
                for kk in 0..COMPARED {
                    let (Some(a), Some(b)) = (raw(&p.camera, kk), raw(&q.camera, kk)) else { continue };
                    let d = f64::from(((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()) / 10.0;
                    push(&mut self.errs, d, 3000);
                    if kk == j::LEFT_HAND || kk == j::RIGHT_HAND {
                        push(&mut self.hand_errs, d, 3000);
                    }
                }
            }
        }
    }

    fn draw_skeleton(&mut self, ctx: &FrameCtx, view: &PersonsView, color: Option<Rgba>, width: f32) {
        self.over.line_width = width;
        for p in view {
            let c = color.unwrap_or(Rgba(p.color[0], p.color[1], p.color[2], 1.0));
            for &(a, b) in &BONES {
                let (Some(pa), Some(pb)) = (p.image.joints[a], p.image.joints[b]) else { continue };
                let [x0, y0] = to_screen(ctx, pa.x, pa.y);
                let [x1, y1] = to_screen(ctx, pb.x, pb.y);
                self.over.line(x0, y0, x1, y1, c);
            }
        }
    }
}

impl Scene for LiveExakt {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let now = ctx.now_ms;
        let time = ctx.time;
        let view = ctx.kinect.view.clone();
        self.over.clear();
        let alpha = ctx.params.f("silhouettes");
        if alpha > 0.0 {
            self.update_mask(ctx.kinect);
        }

        // live: a hand goes up -> a claim at once
        for p in &*view {
            for hand in HANDS {
                let key = (p.id, hand);
                if !self.raised.contains(&key) && hand_raised(Some(p), hand, UP) {
                    self.raised.insert(key);
                    let [x, y] = p.image.joints[hand].map_or([-1e4, -1e4], |a| to_screen(ctx, a.x, a.y));
                    let mut c = Claim { key: self.next_key, id: p.id, hand, seq: 0, verdict: Verdict::Open };
                    self.next_key += 1;
                    self.check.add(&view, &mut c, now);
                    self.marks.push(Mark { claim: c.key, x, y, until: f32::INFINITY });
                    self.claims.push(c);
                } else if self.raised.contains(&key) && !hand_raised(Some(p), hand, DOWN) {
                    self.raised.remove(&key);
                }
            }
        }
        self.raised.retain(|(id, _)| view.by_id(*id).is_some());

        // exact: settle the claims, measure the live error
        self.settled.clear();
        let mut settled = std::mem::take(&mut self.settled);
        self.check.update(ctx.kinect, &mut self.claims, now, &mut settled);
        for &(key, verdict, waited) in &settled {
            match verdict {
                Verdict::Ok => self.ok += 1,
                Verdict::No => self.no += 1,
                _ => self.none += 1,
            }
            if matches!(verdict, Verdict::Ok | Verdict::No) {
                push(&mut self.waited, waited, 200);
            }
            if let Some(m) = self.marks.iter_mut().find(|m| m.claim == key) {
                m.until = time + 1.5;
            }
        }
        self.settled = settled;
        self.measure(ctx.kinect);

        // skeletons: live (colored) and exact (white, dashed)
        let exact = ctx.kinect.exact_view.clone().filter(|e| !Arc::ptr_eq(e, &view));
        let same_frame = match (&exact, ctx.params.s("compare") == "gleiches Frame") {
            (Some(e), true) => e.seq.and_then(|s| ctx.kinect.live_at(s)),
            _ => None,
        };
        match &same_frame {
            Some(lv) => self.draw_skeleton(ctx, lv, None, 3.0),
            None if exact.is_some() && ctx.params.s("compare") == "gleiches Frame" => {}
            None => self.draw_skeleton(ctx, &view, None, 3.0),
        }
        if let Some(e) = &exact {
            self.over.dash = vec![6.0, 4.0];
            self.draw_skeleton(ctx, e, Some(Rgba(1.0, 1.0, 1.0, 1.0)), 1.5);
            self.over.dash.clear();
        }

        // the claims: yellow while open, green confirmed, red overruled, gray no exact data
        self.marks.retain(|m| m.until > time);
        let keep: HashSet<u64> = self.marks.iter().map(|m| m.claim).collect();
        let open: HashSet<u64> = self.check.pending.iter().map(|p| p.0).collect();
        self.claims.retain(|c| keep.contains(&c.key) || open.contains(&c.key));
        self.over.line_width = 4.0;
        for m in &self.marks {
            let verdict = self.claims.iter().find(|c| c.key == m.claim).map_or(Verdict::NoData, |c| c.verdict);
            let c = match verdict {
                Verdict::Open => Rgba::hex("#ffd23a"),
                Verdict::Ok => Rgba::hex("#3dff7a"),
                Verdict::No => Rgba::hex("#ff3d5a"),
                Verdict::NoData => Rgba::hex("#888888"),
            };
            self.over.alpha = if m.until.is_infinite() { 1.0 } else { (m.until - time).clamp(0.0, 1.0) };
            self.over.stroke_arc(m.x, m.y, 22.0, 0.0, std::f32::consts::TAU, c);
        }
        self.over.alpha = 1.0;

        // status (twice a second)
        if time - self.shown_at > 0.5 {
            self.shown_at = time;
            let n = view.len();
            let mode = match ctx.kinect.mode {
                ViewMode::Both => "both",
                ViewMode::Exact => "exact",
                ViewMode::Live => "live",
            };
            let lag = exact.as_ref().map(|e| ((view.capture_time_us as f64 - e.capture_time_us as f64) / 1000.0).round());
            let f = |x: Option<f64>| x.map_or("–".to_string(), |v| format!("{v:.1}"));
            let mut parts = vec![format!("{n} {} · {mode}", if n == 1 { "Person" } else { "Personen" })];
            if let Some(l) = lag {
                parts.push(format!("exakt {l} ms hinter live"));
            }
            if !self.errs.is_empty() {
                parts.push(format!("live−exakt: Median {} cm, p90 {} cm, Hände {} cm", f(quantile(&self.errs, 0.5)), f(quantile(&self.errs, 0.9)), f(quantile(&self.hand_errs, 0.5))));
            }
            if self.compared > 0 {
                parts.push(format!("{} von {} ohne Live-Gegenstück", self.missing, self.compared));
            }
            let w50 = quantile(&self.waited, 0.5);
            parts.push(format!(
                "Hand hoch: {} bestätigt, {} verworfen{}{}",
                self.ok,
                self.no,
                if self.none > 0 { format!(", {} ohne exakte Daten", self.none) } else { String::new() },
                w50.map_or(String::new(), |w| format!(" (nach {} ms)", w.round()))
            ));
            self.shown = parts.join(" · ");
        }
        ctx.status.clone_from(&self.shown);

        // the picture: silhouettes scaled onto the camera image's place, lines and rings on top
        let [x0, y0] = to_screen(ctx, 0.0, 0.0);
        let [x1, y1] = to_screen(ctx, 511.0, 423.0);
        let has_mask = alpha > 0.0 && ctx.kinect.persons.as_ref().is_some_and(|r| r.labels.is_some());
        let u = [x0, y0, x1, y1, if has_mask { alpha } else { 0.0 }, 0.0, 0.0, 0.0];
        ctx.gpu.queue.write_buffer(&self.ubuf, 0, bytemuck::cast_slice(&u));
        ctx.gpu.write_texture(&self.over_tex, self.over.data(), 4);
        let mut pass = wall::gpu::begin_pass(ctx.encoder, "live-exakt", ctx.target);
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.draw(0..3, 0..1);
        Ok(())
    }
}

wall::export_scenes!(&DEF);
