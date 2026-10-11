//! The GPU for the scenes: Bevy's wgpu device and queue, used directly from the main world (as the
//! scenes used WebGPU in the browser). Shader modules and pipelines are cached by name for the
//! whole run: a scene that starts again (show, crossfade) never compiles a shader, which is what
//! makes a switch stutter-free. Each scene library gets the cache under a name of its own (its
//! version): a scene built anew while the output runs compiles its new shaders. Errors are caught
//! per scene (error scopes), never fatal.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use parking_lot::Mutex;

/// The format of every scene's output (the canvas in the browser, values as displayed: not sRGB-encoded by the GPU).
pub const TARGET_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

#[derive(Default)]
struct Cache {
    shaders: HashMap<String, wgpu::ShaderModule>,
    render: HashMap<String, wgpu::RenderPipeline>,
    compute: HashMap<String, wgpu::ComputePipeline>,
    layouts: HashMap<String, wgpu::BindGroupLayout>,
    samplers: HashMap<String, wgpu::Sampler>,
}

#[derive(Clone)]
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// r32float textures can be sampled linearly (depthSmooth)
    pub float32_filterable: bool,
    cache: Arc<Mutex<Cache>>,
    /// the cache names' prefix (a scene library's version), empty for the output's own
    ns: Arc<str>,
}

/// Polls a future that is ready at once (wgpu native: error scopes, map results).
pub fn ready<F: Future>(f: F) -> Option<F::Output> {
    let mut f = std::pin::pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    match f.as_mut().poll(&mut cx) {
        Poll::Ready(v) => Some(v),
        Poll::Pending => None,
    }
}

pub type GpuResult<T> = Result<T, String>;

impl Gpu {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        let float32_filterable = device.features().contains(wgpu::Features::FLOAT32_FILTERABLE);
        Self { device, queue, float32_filterable, cache: Arc::new(Mutex::new(Cache::default())), ns: Arc::from("") }
    }

    /// The same GPU, its cache names under `ns` (output.rs: a scene library's version).
    pub fn namespaced(&self, ns: &str) -> Gpu {
        Gpu { ns: Arc::from(ns), ..self.clone() }
    }

    fn key(&self, key: &str) -> String {
        if self.ns.is_empty() { key.to_string() } else { format!("{}/{key}", self.ns) }
    }

    /// Runs `f` inside a validation error scope; the first validation error is returned.
    pub fn scoped<T>(&self, f: impl FnOnce() -> T) -> (T, Option<String>) {
        let oom = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let out = f();
        let e1 = ready(validation.pop()).flatten();
        let e2 = ready(oom.pop()).flatten();
        let err = e1.or(e2).map(|e| e.to_string());
        (out, err)
    }

    /// A shader module from WGSL, compiled once per key for the whole run.
    pub fn shader(&self, key: &str, wgsl: &str) -> GpuResult<wgpu::ShaderModule> {
        if let Some(m) = self.cache.lock().shaders.get(&self.key(key)) {
            return Ok(m.clone());
        }
        // naga first: a readable error with line numbers instead of a device error
        if let Err(e) = naga_check(wgsl) {
            return Err(format!("WGSL-Fehler in {key}:\n{e}"));
        }
        let (module, err) = self.scoped(|| {
            self.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(key), source: wgpu::ShaderSource::Wgsl(wgsl.into()) })
        });
        if let Some(e) = err {
            return Err(format!("WGSL-Fehler in {key}: {e}"));
        }
        self.cache.lock().shaders.insert(self.key(key), module.clone());
        Ok(module)
    }

    /// A render pipeline, created once per key.
    pub fn render_pipeline(&self, key: &str, make: impl FnOnce(&wgpu::Device) -> wgpu::RenderPipeline) -> GpuResult<wgpu::RenderPipeline> {
        if let Some(p) = self.cache.lock().render.get(&self.key(key)) {
            return Ok(p.clone());
        }
        let (p, err) = self.scoped(|| make(&self.device));
        if let Some(e) = err {
            return Err(format!("Pipeline {key}: {e}"));
        }
        self.cache.lock().render.insert(self.key(key), p.clone());
        Ok(p)
    }

    pub fn compute_pipeline(&self, key: &str, make: impl FnOnce(&wgpu::Device) -> wgpu::ComputePipeline) -> GpuResult<wgpu::ComputePipeline> {
        if let Some(p) = self.cache.lock().compute.get(&self.key(key)) {
            return Ok(p.clone());
        }
        let (p, err) = self.scoped(|| make(&self.device));
        if let Some(e) = err {
            return Err(format!("Pipeline {key}: {e}"));
        }
        self.cache.lock().compute.insert(self.key(key), p.clone());
        Ok(p)
    }

    pub fn bind_group_layout(&self, key: &str, entries: &[wgpu::BindGroupLayoutEntry]) -> wgpu::BindGroupLayout {
        if let Some(l) = self.cache.lock().layouts.get(&self.key(key)) {
            return l.clone();
        }
        let l = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(key), entries });
        self.cache.lock().layouts.insert(self.key(key), l.clone());
        l
    }

    /// Linear clamp-to-edge sampler (as the browser scenes create them).
    pub fn linear_sampler(&self) -> wgpu::Sampler {
        self.sampler("linear-clamp", wgpu::FilterMode::Linear, wgpu::AddressMode::ClampToEdge)
    }

    pub fn nearest_sampler(&self) -> wgpu::Sampler {
        self.sampler("nearest-clamp", wgpu::FilterMode::Nearest, wgpu::AddressMode::ClampToEdge)
    }

    pub fn sampler(&self, key: &str, filter: wgpu::FilterMode, address: wgpu::AddressMode) -> wgpu::Sampler {
        if let Some(s) = self.cache.lock().samplers.get(&self.key(key)) {
            return s.clone();
        }
        let s = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some(key),
            address_mode_u: address,
            address_mode_v: address,
            address_mode_w: address,
            mag_filter: filter,
            min_filter: filter,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        self.cache.lock().samplers.insert(self.key(key), s.clone());
        s
    }

    /// A 2D texture with the usual usages for scene work.
    pub fn texture(&self, label: &str, w: u32, h: u32, format: wgpu::TextureFormat, usage: wgpu::TextureUsages) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    }

    /// A render target that can be sampled and copied (a scene's output, feedback buffers).
    pub fn target(&self, label: &str, w: u32, h: u32, format: wgpu::TextureFormat) -> wgpu::Texture {
        self.texture(
            label,
            w,
            h,
            format,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
        )
    }

    pub fn buffer(&self, label: &str, size: u64, usage: wgpu::BufferUsages) -> wgpu::Buffer {
        self.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size.max(16), usage, mapped_at_creation: false })
    }

    pub fn uniform_buffer(&self, label: &str, size: u64) -> wgpu::Buffer {
        self.buffer(label, size.div_ceil(16) * 16, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST)
    }

    pub fn storage_buffer(&self, label: &str, size: u64) -> wgpu::Buffer {
        self.buffer(label, size.div_ceil(4) * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC)
    }

    /// Writes a whole 2D texture (tightly packed rows).
    pub fn write_texture(&self, tex: &wgpu::Texture, data: &[u8], bytes_per_pixel: u32) {
        let size = tex.size();
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            data,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.width * bytes_per_pixel), rows_per_image: Some(size.height) },
            size,
        );
    }

    pub fn encoder(&self, label: &str) -> wgpu::CommandEncoder {
        self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(label) })
    }
}

/// Parses and validates WGSL with naga, for error messages with lines.
pub fn naga_check(wgsl: &str) -> Result<(), String> {
    let module = naga::front::wgsl::parse_str(wgsl).map_err(|e| e.emit_to_string(wgsl))?;
    let mut v = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all());
    v.validate(&module).map_err(|e| e.emit_to_string(wgsl))?;
    Ok(())
}

/// A fullscreen triangle vertex shader (vs_fullscreen), as the browser scenes use it.
pub const FULLSCREEN_WGSL: &str = r"
@vertex fn vs_fullscreen(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
";

/// A color attachment that clears to black and stores.
pub fn clear_attachment(view: &wgpu::TextureView) -> wgpu::RenderPassColorAttachment<'_> {
    wgpu::RenderPassColorAttachment {
        view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
    }
}

/// Begins a render pass on one color attachment that clears to black.
pub fn begin_pass<'a>(enc: &'a mut wgpu::CommandEncoder, label: &str, view: &wgpu::TextureView) -> wgpu::RenderPass<'a> {
    enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(clear_attachment(view))],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

/// Layout entry shorthands (visibility given by the caller).
pub mod layout {
    pub fn uniform(binding: u32, vis: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
        wgpu::BindGroupLayoutEntry { binding, visibility: vis, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }
    }
    pub fn storage(binding: u32, vis: wgpu::ShaderStages, read_only: bool) -> wgpu::BindGroupLayoutEntry {
        wgpu::BindGroupLayoutEntry {
            binding,
            visibility: vis,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        }
    }
    pub fn texture(binding: u32, vis: wgpu::ShaderStages, sample_type: wgpu::TextureSampleType) -> wgpu::BindGroupLayoutEntry {
        wgpu::BindGroupLayoutEntry { binding, visibility: vis, ty: wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None }
    }
    pub fn float_tex(binding: u32, vis: wgpu::ShaderStages, filterable: bool) -> wgpu::BindGroupLayoutEntry {
        texture(binding, vis, wgpu::TextureSampleType::Float { filterable })
    }
    pub fn uint_tex(binding: u32, vis: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
        texture(binding, vis, wgpu::TextureSampleType::Uint)
    }
    pub fn sampler(binding: u32, vis: wgpu::ShaderStages, filtering: bool) -> wgpu::BindGroupLayoutEntry {
        wgpu::BindGroupLayoutEntry {
            binding,
            visibility: vis,
            ty: wgpu::BindingType::Sampler(if filtering { wgpu::SamplerBindingType::Filtering } else { wgpu::SamplerBindingType::NonFiltering }),
            count: None,
        }
    }
    pub fn storage_tex(binding: u32, vis: wgpu::ShaderStages, format: wgpu::TextureFormat) -> wgpu::BindGroupLayoutEntry {
        wgpu::BindGroupLayoutEntry {
            binding,
            visibility: vis,
            ty: wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format, view_dimension: wgpu::TextureViewDimension::D2 },
            count: None,
        }
    }
}
