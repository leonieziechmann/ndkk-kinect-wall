//! The last step in the render world: the finished LED image (a texture the main world renders,
//! see output.rs) goes into the window, pixel-exact at the setup's offset ("pixelgenau"), stretched
//! over the window ("Fenster füllen") or fitted ("einpassen", windowed tests). One fullscreen
//! triangle in Bevy's 2D camera pass; everything else of Bevy's 2D pipeline stays idle.

use bevy::core_pipeline::{Core2d, Core2dSystems};
use bevy::prelude::*;
use bevy::render::renderer::{RenderContext, RenderDevice, ViewQuery};
use bevy::render::view::ViewTarget;
use bevy::render::{Extract, ExtractSchedule, Render, RenderApp, RenderSystems};

/// Main world: what the window shows (set by output.rs every frame).
#[derive(Resource, Clone, Default)]
pub struct OutputImage {
    /// the LED image (rgba8unorm, values as displayed)
    pub view: Option<wgpu::TextureView>,
    /// changes whenever `view` is a new texture
    pub generation: u64,
    /// LED pixels
    pub led: [u32; 2],
    /// 'pixel' | 'stretch' | 'fit'
    pub fit: Fit,
    /// pixel mode: the LED image's top left corner in window pixels
    pub offset: [i32; 2],
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Fit {
    #[default]
    Pixel,
    Stretch,
    Fit,
}

/// Render world copy of [`OutputImage`].
#[derive(Resource, Clone, Default)]
struct RenderOutput(OutputImage);

#[derive(Resource, Default)]
struct BlitState {
    pipeline: Option<(wgpu::TextureFormat, wgpu::RenderPipeline)>,
    layout: Option<wgpu::BindGroupLayout>,
    sampler: Option<wgpu::Sampler>,
    uniform: Option<wgpu::Buffer>,
    group: Option<(u64, wgpu::BindGroup)>,
    /// the uniform for this frame: [window w, h, led w, h] [offset x, y, scale x, y] [srgb, smooth, 0, 0]
    data: [f32; 12],
    ready: bool,
}

pub struct CompositorPlugin;

impl Plugin for CompositorPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<OutputImage>();
        let Some(render_app) = app.get_sub_app_mut(RenderApp) else {
            return;
        };
        render_app
            .init_resource::<RenderOutput>()
            .init_resource::<BlitState>()
            .add_systems(ExtractSchedule, extract_output)
            .add_systems(Render, prepare_blit.in_set(RenderSystems::PrepareBindGroups))
            .add_systems(Core2d, blit_led.in_set(Core2dSystems::MainPass).after(bevy::core_pipeline::core_2d::main_transparent_pass_2d));
    }
}

fn extract_output(main: Extract<Res<OutputImage>>, mut out: ResMut<RenderOutput>) {
    if main.is_changed() || out.0.generation != main.generation {
        out.0 = main.clone();
    }
}

const BLIT_WGSL: &str = r"
struct U { win: vec4f, place: vec4f, opts: vec4f };
@group(0) @binding(0) var led: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn to_linear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // window pixel -> LED pixel
  let p = (pos.xy - u.place.xy) / u.place.zw;
  var c = vec3f(0.0);
  if (all(p >= vec2f(0.0)) && all(p < u.win.zw)) {
    if (u.opts.y > 0.5) {
      c = textureSampleLevel(led, samp, p / u.win.zw, 0.0).rgb;
    } else {
      c = textureLoad(led, vec2i(p), 0).rgb;
    }
  }
  if (u.opts.x > 0.5) { c = to_linear(c); }
  return vec4f(c, 1.0);
}
";

fn prepare_blit(device: Res<RenderDevice>, out: Res<RenderOutput>, views: Query<&ViewTarget>, mut st: ResMut<BlitState>, queue: Res<bevy::render::renderer::RenderQueue>) {
    st.ready = false;
    let Some(view) = out.0.view.as_ref() else {
        return;
    };
    let Some(target) = views.iter().next() else {
        return;
    };
    let dev = device.wgpu_device();
    let format = target.main_texture_format();
    if st.layout.is_none() {
        let vis = wgpu::ShaderStages::FRAGMENT;
        st.layout = Some(dev.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("led blit"),
            entries: &[
                crate::gpu::layout::float_tex(0, vis, true),
                crate::gpu::layout::sampler(1, vis, true),
                crate::gpu::layout::uniform(2, vis),
            ],
        }));
        st.sampler = Some(dev.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("led blit"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        }));
        st.uniform = Some(dev.create_buffer(&wgpu::BufferDescriptor {
            label: Some("led blit"),
            size: 48,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }));
    }
    let (Some(layout), Some(sampler), Some(uniform)) = (st.layout.clone(), st.sampler.clone(), st.uniform.clone()) else {
        return;
    };
    if st.pipeline.as_ref().map(|p| p.0) != Some(format) {
        let module = dev.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("led blit"), source: wgpu::ShaderSource::Wgsl(BLIT_WGSL.into()) });
        let pl = dev.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("led blit"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipeline = dev.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("led blit"),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        st.pipeline = Some((format, pipeline));
    }
    if st.group.as_ref().map(|g| g.0) != Some(out.0.generation) {
        let group = dev.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("led blit"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: uniform.as_entire_binding() },
            ],
        });
        st.group = Some((out.0.generation, group));
    }
    // where the LED image goes in the window
    let size = target.main_texture().size();
    let (ww, wh) = (size.width as f32, size.height as f32);
    let (lw, lh) = (out.0.led[0].max(1) as f32, out.0.led[1].max(1) as f32);
    let (place, smooth) = match out.0.fit {
        Fit::Pixel => ([out.0.offset[0] as f32, out.0.offset[1] as f32, 1.0, 1.0], false),
        Fit::Stretch => ([0.0, 0.0, ww / lw, wh / lh], true),
        Fit::Fit => {
            let s = (ww / lw).min(wh / lh);
            ([(ww - lw * s) / 2.0, (wh - lh * s) / 2.0, s, s], s < 1.5)
        }
    };
    let srgb = format.is_srgb();
    st.data = [ww, wh, lw, lh, place[0], place[1], place[2], place[3], if srgb { 1.0 } else { 0.0 }, if smooth { 1.0 } else { 0.0 }, 0.0, 0.0];
    queue.write_buffer(&uniform, 0, bytemuck::cast_slice(&st.data));
    st.ready = true;
}

fn blit_led(view: ViewQuery<&ViewTarget>, st: Res<BlitState>, mut ctx: RenderContext) {
    if !st.ready {
        return;
    }
    let (Some((_, pipeline)), Some((_, group))) = (st.pipeline.as_ref(), st.group.as_ref()) else {
        return;
    };
    let target = view.into_inner();
    let mut pass = ctx.command_encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("led blit"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target.main_texture_view(),
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.draw(0..3, 0..1);
}
