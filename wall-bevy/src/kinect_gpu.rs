//! GPU copies of the Kinect data (port of KinectGpu in web/lib/kinect-data.js), created on first
//! use and refreshed whenever new data arrives. Never recreated, so bind groups stay valid.
//!
//!   depthTexture  r32float    depth in meters, 0 = no measurement
//!   irTexture     r8unorm     infrared brightness 0..1
//!   lutTexture    rg32float   ray x, y per pixel: point = (x·z, y·z, z)
//!   depthBuffer   storage     u16 mm, two per u32;  irBuffer: u8, four per u32;  lutBuffer: vec2f
//!   personLabelTexture  r8uint     slot per pixel, 0 = nobody
//!   personDepthTexture  r32float   meters of person pixels only
//!   personLabelBuffer, personDepthBuffer, personIndexBuffer   storage (u8 ×4, u16 ×2, u32)
//!   personPointBuffer   array<vec4f>: per slot and point (POINTS, then the info entry) two vec4f

use std::collections::HashSet;

use parking_lot::Mutex;

use crate::gpu::Gpu;
use crate::kinect::KinectData;
use crate::persons::{MAX_PERSONS, N, NPOINTS};

pub const KW: u32 = 512;
pub const KH: u32 = 424;
/// entries per slot in personPointBuffer: the points, then the info
pub const PERSON_POINTS: usize = NPOINTS + 1;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Res {
    DepthTex,
    IrTex,
    LutTex,
    DepthBuf,
    IrBuf,
    LutBuf,
    LabelTex,
    PDepthTex,
    LabelBuf,
    PDepthBuf,
    IndexBuf,
    PointBuf,
}

pub struct KinectGpu {
    gpu: Gpu,
    depth_tex: wgpu::Texture,
    ir_tex: wgpu::Texture,
    lut_tex: wgpu::Texture,
    label_tex: wgpu::Texture,
    pdepth_tex: wgpu::Texture,
    depth_buf: wgpu::Buffer,
    ir_buf: wgpu::Buffer,
    lut_buf: wgpu::Buffer,
    label_buf: wgpu::Buffer,
    pdepth_buf: wgpu::Buffer,
    index_buf: wgpu::Buffer,
    point_buf: wgpu::Buffer,
    /// what scenes use (only those are uploaded), and what is used but not filled yet
    used: Mutex<(HashSet<Res>, HashSet<Res>)>,
    points: Mutex<Vec<f32>>,
}

fn tex(gpu: &Gpu, label: &str, format: wgpu::TextureFormat) -> wgpu::Texture {
    gpu.texture(label, KW, KH, format, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST)
}

impl KinectGpu {
    pub fn new(gpu: &Gpu) -> Self {
        let n = N as u64;
        Self {
            depth_tex: tex(gpu, "kinect depthTexture", wgpu::TextureFormat::R32Float),
            ir_tex: tex(gpu, "kinect irTexture", wgpu::TextureFormat::R8Unorm),
            lut_tex: tex(gpu, "kinect lutTexture", wgpu::TextureFormat::Rg32Float),
            label_tex: tex(gpu, "kinect personLabelTexture", wgpu::TextureFormat::R8Uint),
            pdepth_tex: tex(gpu, "kinect personDepthTexture", wgpu::TextureFormat::R32Float),
            depth_buf: gpu.storage_buffer("kinect depthBuffer", n * 2),
            ir_buf: gpu.storage_buffer("kinect irBuffer", n),
            lut_buf: gpu.storage_buffer("kinect lutBuffer", n * 8),
            label_buf: gpu.storage_buffer("kinect personLabelBuffer", n),
            pdepth_buf: gpu.storage_buffer("kinect personDepthBuffer", n * 2),
            index_buf: gpu.storage_buffer("kinect personIndexBuffer", n * 4),
            point_buf: gpu.storage_buffer("kinect personPointBuffer", ((MAX_PERSONS + 1) * PERSON_POINTS * 32) as u64),
            used: Mutex::new((HashSet::new(), HashSet::new())),
            points: Mutex::new(vec![0.0; (MAX_PERSONS + 1) * PERSON_POINTS * 8]),
            gpu: gpu.clone(),
        }
    }

    fn use_(&self, r: Res) {
        let mut u = self.used.lock();
        if u.0.insert(r) {
            u.1.insert(r);
        }
    }

    pub fn depth_texture(&self) -> wgpu::TextureView {
        self.use_(Res::DepthTex);
        self.depth_tex.create_view(&Default::default())
    }
    pub fn ir_texture(&self) -> wgpu::TextureView {
        self.use_(Res::IrTex);
        self.ir_tex.create_view(&Default::default())
    }
    pub fn lut_texture(&self) -> wgpu::TextureView {
        self.use_(Res::LutTex);
        self.lut_tex.create_view(&Default::default())
    }
    pub fn person_label_texture(&self) -> wgpu::TextureView {
        self.use_(Res::LabelTex);
        self.label_tex.create_view(&Default::default())
    }
    pub fn person_depth_texture(&self) -> wgpu::TextureView {
        self.use_(Res::PDepthTex);
        self.pdepth_tex.create_view(&Default::default())
    }
    pub fn depth_buffer(&self) -> wgpu::Buffer {
        self.use_(Res::DepthBuf);
        self.depth_buf.clone()
    }
    pub fn ir_buffer(&self) -> wgpu::Buffer {
        self.use_(Res::IrBuf);
        self.ir_buf.clone()
    }
    pub fn lut_buffer(&self) -> wgpu::Buffer {
        self.use_(Res::LutBuf);
        self.lut_buf.clone()
    }
    pub fn person_label_buffer(&self) -> wgpu::Buffer {
        self.use_(Res::LabelBuf);
        self.label_buf.clone()
    }
    pub fn person_depth_buffer(&self) -> wgpu::Buffer {
        self.use_(Res::PDepthBuf);
        self.pdepth_buf.clone()
    }
    pub fn person_index_buffer(&self) -> wgpu::Buffer {
        self.use_(Res::IndexBuf);
        self.index_buf.clone()
    }
    pub fn person_point_buffer(&self) -> wgpu::Buffer {
        self.use_(Res::PointBuf);
        self.point_buf.clone()
    }

    fn due(&self, r: Res, fresh: bool) -> bool {
        let u = self.used.lock();
        u.0.contains(&r) && (fresh || u.1.contains(&r))
    }

    fn filled(&self, r: Res) {
        self.used.lock().1.remove(&r);
    }

    /// Once per frame after KinectData::begin_frame: uploads what is new (only what scenes use).
    pub fn upload(&self, k: &KinectData) {
        let g = self.gpu.clone();
        let q = &g.queue;
        let view_fresh = k.view.fresh;
        if self.due(Res::PointBuf, view_fresh) {
            let mut d = self.points.lock();
            d.fill(0.0);
            for p in &k.view.all {
                let s = p.slot as usize;
                if s < 1 || s > MAX_PERSONS {
                    continue;
                }
                for jj in 0..NPOINTS {
                    let o = (s * PERSON_POINTS + jj) * 8;
                    let w = p.joints[jj];
                    let c = if p.visible && w.is_some() { p.confidence[jj].max(0.01) } else { 0.0 };
                    if let Some(im) = p.image.joints[jj] {
                        d[o..o + 4].copy_from_slice(&[im.x / KW as f32, im.y / KH as f32, w.map(|v| v.z).unwrap_or(0.0), c]);
                    }
                    if let Some(w) = w {
                        d[o + 4..o + 8].copy_from_slice(&[w.x, w.y, w.z, c]);
                    }
                }
                let o = (s * PERSON_POINTS + NPOINTS) * 8;
                let b = p.image.bbox;
                d[o..o + 8].copy_from_slice(&[if p.visible { 1.0 } else { 0.0 }, p.id as f32, p.height, p.age, b[0] / KW as f32, b[1] / KH as f32, b[2] / KW as f32, b[3] / KH as f32]);
            }
            q.write_buffer(&self.point_buf, 0, bytemuck::cast_slice(&d));
            self.filled(Res::PointBuf);
        }
        if let Some(p) = &k.persons {
            let fresh = k.fresh.persons;
            if let Some(l) = &p.labels {
                if self.due(Res::LabelTex, fresh) {
                    g.write_texture(&self.label_tex, l, 1);
                    self.filled(Res::LabelTex);
                }
                if self.due(Res::LabelBuf, fresh) {
                    q.write_buffer(&self.label_buf, 0, l);
                    self.filled(Res::LabelBuf);
                }
            }
            if let Some(m) = &p.meters
                && self.due(Res::PDepthTex, fresh)
            {
                g.write_texture(&self.pdepth_tex, bytemuck::cast_slice(m), 4);
                self.filled(Res::PDepthTex);
            }
            if let Some(d) = &p.depth
                && self.due(Res::PDepthBuf, fresh)
            {
                q.write_buffer(&self.pdepth_buf, 0, bytemuck::cast_slice(d));
                self.filled(Res::PDepthBuf);
            }
            if let Some(ix) = &p.indices
                && p.count > 0
                && self.due(Res::IndexBuf, fresh)
            {
                q.write_buffer(&self.index_buf, 0, bytemuck::cast_slice(&ix[..p.count]));
                self.filled(Res::IndexBuf);
            }
        }
        if let Some(d) = &k.depth {
            if self.due(Res::DepthTex, k.fresh.depth) {
                g.write_texture(&self.depth_tex, bytemuck::cast_slice(&d.meters), 4);
                self.filled(Res::DepthTex);
            }
            if self.due(Res::DepthBuf, k.fresh.depth) {
                q.write_buffer(&self.depth_buf, 0, bytemuck::cast_slice(&d.mm));
                self.filled(Res::DepthBuf);
            }
        }
        if let Some(ir) = &k.ir {
            if self.due(Res::IrTex, k.fresh.ir) {
                g.write_texture(&self.ir_tex, &ir.data, 1);
                self.filled(Res::IrTex);
            }
            if self.due(Res::IrBuf, k.fresh.ir) {
                q.write_buffer(&self.ir_buf, 0, &ir.data);
                self.filled(Res::IrBuf);
            }
        }
        // the ray tables start as pinhole approximation and get the real LUT once it arrives
        if self.due(Res::LutTex, k.fresh.lut) || self.due(Res::LutBuf, k.fresh.lut) {
            let rays = k.rays();
            if self.due(Res::LutTex, k.fresh.lut) {
                g.write_texture(&self.lut_tex, bytemuck::cast_slice(&rays), 8);
                self.filled(Res::LutTex);
            }
            if self.due(Res::LutBuf, k.fresh.lut) {
                q.write_buffer(&self.lut_buf, 0, bytemuck::cast_slice(&rays));
                self.filled(Res::LutBuf);
            }
        }
    }
}
