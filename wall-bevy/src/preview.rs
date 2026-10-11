//! Pictures of the LED image without stalling the GPU: previews for the control center (small JPEG,
//! five a second while it asks) and test shots (PNG). The copy is encoded with the frame, mapped
//! asynchronously, read a frame or two later, and encoded in a thread of its own.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};

use crossbeam_channel::{Receiver, Sender};

use wall::gpu::{FULLSCREEN_WGSL, Gpu, layout};

pub enum Purpose {
    /// JPEG data URL for the control center
    Preview,
    /// PNG file
    Shot(PathBuf),
}

struct Pending {
    buf: wgpu::Buffer,
    w: u32,
    h: u32,
    row: u32,
    purpose: Purpose,
    /// 0 waiting, 1 mapped, 2 failed
    state: Arc<AtomicU8>,
    mapping: bool,
}

pub struct Readback {
    pending: Vec<Pending>,
    small: Option<(u32, u32, wgpu::Texture, wgpu::BindGroup)>,
    blit: Option<(wgpu::RenderPipeline, wgpu::BindGroupLayout)>,
    to_encoder: Sender<(Purpose, u32, u32, Vec<u8>)>,
    /// pictures handed to the encoder thread and not written yet
    encoding: Arc<AtomicUsize>,
    /// finished previews (data URL, w, h)
    pub previews: Receiver<(String, u32, u32)>,
}

const SMALL_WGSL: &str = r"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> size: vec4f;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(src, samp, pos.xy / size.xy, 0.0).rgb, 1.0);
}";

impl Readback {
    pub fn new() -> Self {
        let (tx, rx) = crossbeam_channel::bounded::<(Purpose, u32, u32, Vec<u8>)>(8);
        let (ptx, prx) = crossbeam_channel::bounded(4);
        let encoding = Arc::new(AtomicUsize::new(0));
        let enc = encoding.clone();
        let _ = std::thread::Builder::new().name("preview-encode".into()).spawn(move || encoder(rx, ptx, enc));
        Self { pending: Vec::new(), small: None, blit: None, to_encoder: tx, encoding, previews: prx }
    }

    /// Copies still on the GPU or in the encoder (a test waits for its last PNG).
    pub fn busy(&self) -> usize {
        self.pending.len() + self.encoding.load(Ordering::Acquire)
    }

    /// Copies `tex` (rgba8unorm) to a buffer in `enc`; for previews scaled down to at most 640 px wide.
    pub fn request(&mut self, gpu: &Gpu, enc: &mut wgpu::CommandEncoder, tex: &wgpu::Texture, view: &wgpu::TextureView, purpose: Purpose) {
        if self.pending.len() >= 3 {
            return; // the GPU is behind: skip this one
        }
        let size = tex.size();
        let (w, h, src) = match purpose {
            Purpose::Preview => {
                let scale = (640.0 / size.width as f32).min(1.0);
                let w = ((size.width as f32 * scale).round() as u32).max(1);
                let h = ((size.height as f32 * scale).round() as u32).max(1);
                let Some(small) = self.small_texture(gpu, view, w, h) else {
                    return;
                };
                let Some((pipe, _)) = &self.blit else { return };
                let Some((_, _, stex, group)) = &self.small else { return };
                let sview = stex.create_view(&Default::default());
                {
                    let mut pass = wall::gpu::begin_pass(enc, "preview small", &sview);
                    pass.set_pipeline(pipe);
                    pass.set_bind_group(0, group, &[]);
                    pass.draw(0..3, 0..1);
                }
                (w, h, small)
            }
            Purpose::Shot(_) => (size.width, size.height, tex.clone()),
        };
        let row = (w * 4).div_ceil(256) * 256;
        let buf = gpu.buffer("readback", u64::from(row * h), wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST);
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &src, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.pending.push(Pending { buf, w, h, row, purpose, state: Arc::new(AtomicU8::new(0)), mapping: false });
    }

    fn small_texture(&mut self, gpu: &Gpu, src: &wgpu::TextureView, w: u32, h: u32) -> Option<wgpu::Texture> {
        if self.blit.is_none() {
            let m = gpu.shader("preview small", &format!("{FULLSCREEN_WGSL}\n{SMALL_WGSL}")).ok()?;
            let f = wgpu::ShaderStages::FRAGMENT;
            let bgl = gpu.bind_group_layout("preview small", &[layout::float_tex(0, f, true), layout::sampler(1, f, true), layout::uniform(2, f)]);
            let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
            let p = gpu
                .render_pipeline("preview small", |d| {
                    d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                        label: Some("preview small"),
                        layout: Some(&pl),
                        vertex: wgpu::VertexState { module: &m, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
                        fragment: Some(wgpu::FragmentState {
                            module: &m,
                            entry_point: Some("fs"),
                            compilation_options: Default::default(),
                            targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                        }),
                        primitive: Default::default(),
                        depth_stencil: None,
                        multisample: Default::default(),
                        multiview_mask: None,
                        cache: None,
                    })
                })
                .ok()?;
            self.blit = Some((p, bgl));
        }
        if self.small.as_ref().is_none_or(|s| s.0 != w || s.1 != h) {
            let (_, bgl) = self.blit.as_ref()?;
            let tex = gpu.target("preview small", w, h, wgpu::TextureFormat::Rgba8Unorm);
            let ub = gpu.uniform_buffer("preview size", 16);
            gpu.queue.write_buffer(&ub, 0, bytemuck::cast_slice(&[w as f32, h as f32, 0.0, 0.0]));
            let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("preview small"),
                layout: bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&gpu.linear_sampler()) },
                    wgpu::BindGroupEntry { binding: 2, resource: ub.as_entire_binding() },
                ],
            });
            self.small = Some((w, h, tex, group));
        }
        self.small.as_ref().map(|s| s.2.clone())
    }

    /// After the frame was submitted: starts mapping, polls, hands finished copies to the encoder.
    pub fn after_submit(&mut self, gpu: &Gpu) {
        for p in &mut self.pending {
            if !p.mapping {
                p.mapping = true;
                let st = p.state.clone();
                p.buf.slice(..).map_async(wgpu::MapMode::Read, move |r| st.store(if r.is_ok() { 1 } else { 2 }, Ordering::Release));
            }
        }
        if self.pending.is_empty() {
            return;
        }
        let _ = gpu.device.poll(wgpu::PollType::Poll);
        let mut i = 0;
        while i < self.pending.len() {
            match self.pending[i].state.load(Ordering::Acquire) {
                0 => i += 1,
                s => {
                    let p = self.pending.remove(i);
                    if s == 1 {
                        let mut out = Vec::with_capacity((p.w * p.h * 4) as usize);
                        if let Ok(data) = p.buf.slice(..).get_mapped_range() {
                            for y in 0..p.h {
                                let at = (y * p.row) as usize;
                                out.extend_from_slice(&data[at..at + (p.w * 4) as usize]);
                            }
                        }
                        p.buf.unmap();
                        self.encoding.fetch_add(1, Ordering::AcqRel);
                        if self.to_encoder.try_send((p.purpose, p.w, p.h, out)).is_err() {
                            self.encoding.fetch_sub(1, Ordering::AcqRel);
                        }
                    }
                }
            }
        }
    }
}

fn encoder(rx: Receiver<(Purpose, u32, u32, Vec<u8>)>, previews: Sender<(String, u32, u32)>, encoding: Arc<AtomicUsize>) {
    while let Ok((purpose, w, h, rgba)) = rx.recv() {
        encode(purpose, w, h, &rgba, &previews);
        encoding.fetch_sub(1, Ordering::AcqRel);
    }
}

fn encode(purpose: Purpose, w: u32, h: u32, rgba: &[u8], previews: &Sender<(String, u32, u32)>) {
    use base64::Engine;
    match purpose {
        Purpose::Preview => {
            let mut jpeg = Vec::new();
            let enc = jpeg_encoder::Encoder::new(&mut jpeg, 72);
            if enc.encode(rgba, w as u16, h as u16, jpeg_encoder::ColorType::Rgba).is_ok() {
                let url = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&jpeg));
                let _ = previews.try_send((url, w, h));
            }
        }
        Purpose::Shot(path) => {
            if let Err(e) = write_png(&path, w, h, rgba) {
                bevy::log::warn!("Bild {}: {e}", path.display());
            }
        }
    }
}

pub fn write_png(path: &std::path::Path, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    Ok(())
}
