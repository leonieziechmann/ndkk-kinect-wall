//! The people as they fall on the LED wall (port of web/lib/wall-persons.js): every person pixel is
//! put into the room and mapped onto the wall (the scene's projection), the nearest one per wall
//! cell wins. The result is a texture over the LED image (uv 0..1, y down):
//!   r covered (sample linearly for soft edges), g distance from the sensor (m), b slot, a infrared.

use crate::gpu::{Gpu, GpuResult, layout};
use crate::kinect::KinectData;
use crate::kinect_gpu::KinectGpu;
use crate::wall::wall_wgsl;

const CELL_PX: u32 = 2; // LED pixels per cell: 504 x 168 cells on the 1008 x 336 wall

fn wgsl() -> String {
    format!(
        r"{}
@group(0) @binding(1) var personLabel: texture_2d<u32>;
@group(0) @binding(2) var personDepth: texture_2d<f32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var irTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> cells: array<atomic<u32>>;
@group(0) @binding(6) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var<uniform> grid: vec4u; // cells wide, high

const EMPTY = 0xffffffffu;

// every person pixel -> its wall cell; the nearest point wins: (mm << 13) | (ir << 5) | slot
@compute @workgroup_size(8, 8)
fn scatter(@builtin(global_invocation_id) id: vec3u) {{
  let size = textureDimensions(personDepth);
  if (id.x >= size.x || id.y >= size.y) {{ return; }}
  let p = vec2i(id.xy);
  let slot = textureLoad(personLabel, p, 0).r;
  let z = textureLoad(personDepth, p, 0).r;
  if (slot == 0u || z < 0.1) {{ return; }}
  let ray = textureLoad(lutTex, p, 0).rg;
  let world = vec3f(WALL.xSign * ray.x * z, -ray.y * z, z);
  let room = wallRoom(world);
  if (!wallInZone(room)) {{ return; }}
  let uv = wallUv(wallFromRoom(room, slot));
  if (!wallOnWall(uv)) {{ return; }}
  let g = min(vec2u(uv * vec2f(grid.xy)), grid.xy - 1u);
  let mm = u32(clamp(room.z, 0.0, 60.0) * 1000.0);
  let ir = u32(saturate(textureLoad(irTex, p, 0).r) * 255.0);
  atomicMin(&cells[g.y * grid.x + g.x], (mm << 13u) | (ir << 5u) | min(slot, 31u));
}}

fn cellAt(c: vec2i) -> u32 {{
  if (any(c < vec2i(0)) || any(c >= vec2i(grid.xy))) {{ return EMPTY; }}
  return atomicLoad(&cells[u32(c.y) * grid.x + u32(c.x)]);
}}

// cells -> texture; a hole with people all around takes the nearest neighbour
@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) id: vec3u) {{
  if (id.x >= grid.x || id.y >= grid.y) {{ return; }}
  let c = vec2i(id.xy);
  var v = cellAt(c);
  if (v == EMPTY) {{
    var n = 0u;
    var best = EMPTY;
    for (var y = -1; y <= 1; y++) {{
      for (var x = -1; x <= 1; x++) {{
        if (x == 0 && y == 0) {{ continue; }}
        let w = cellAt(c + vec2i(x, y));
        if (w != EMPTY) {{
          n++;
          best = min(best, w);
        }}
      }}
    }}
    if (n >= 5u) {{ v = best; }}
  }}
  if (v == EMPTY) {{
    textureStore(outTex, c, vec4f(0.0));
    return;
  }}
  textureStore(outTex, c, vec4f(1.0, f32(v >> 13u) / 1000.0, f32(v & 31u), f32((v >> 5u) & 255u) / 255.0));
}}

@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) id: vec3u) {{
  if (id.x < grid.x * grid.y) {{ atomicStore(&cells[id.x], EMPTY); }}
}}
",
        wall_wgsl(0, 0)
    )
}

pub struct WallPersons {
    pipes: [wgpu::ComputePipeline; 3],
    group: wgpu::BindGroup,
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub w: u32,
    pub h: u32,
    last_seq: Option<u32>,
    cleared: bool,
}

impl WallPersons {
    /// The wall image of the people for a scene instance (its wall uniform buffer).
    pub fn new(gpu: &Gpu, kg: &KinectGpu, wall_buf: &wgpu::Buffer, led: [u32; 2]) -> GpuResult<Self> {
        let module = gpu.shader("wall-persons", &wgsl())?;
        let c = wgpu::ShaderStages::COMPUTE;
        let bgl = gpu.bind_group_layout(
            "wall-persons",
            &[
                layout::uniform(0, c),
                layout::uint_tex(1, c),
                layout::float_tex(2, c, false),
                layout::float_tex(3, c, false),
                layout::float_tex(4, c, true),
                layout::storage(5, c, false),
                layout::storage_tex(6, c, wgpu::TextureFormat::Rgba16Float),
                layout::uniform(7, c),
            ],
        );
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("wall-persons"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let mk = |entry: &str| {
            gpu.compute_pipeline(&format!("wall-persons {entry}"), |d| {
                d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(entry),
                    layout: Some(&pl),
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    cache: None,
                })
            })
        };
        let pipes = [mk("scatter")?, mk("resolve")?, mk("clear")?];
        let w = (led[0] as f32 / CELL_PX as f32).round().max(8.0) as u32;
        let h = (led[1] as f32 / CELL_PX as f32).round().max(8.0) as u32;
        let cells = gpu.storage_buffer("wall-persons cells", u64::from(w * h) * 4);
        gpu.queue.write_buffer(&cells, 0, bytemuck::cast_slice(&vec![0xffff_ffffu32; (w * h) as usize]));
        let texture = gpu.texture("wall-persons", w, h, wgpu::TextureFormat::Rgba16Float, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING);
        let view = texture.create_view(&Default::default());
        let grid = gpu.uniform_buffer("wall-persons grid", 16);
        gpu.queue.write_buffer(&grid, 0, bytemuck::cast_slice(&[w, h, 0, 0]));
        let views = [kg.person_label_texture(), kg.person_depth_texture(), kg.lut_texture(), kg.ir_texture()];
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wall-persons"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wall_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&views[0]) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&views[1]) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&views[2]) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&views[3]) },
                wgpu::BindGroupEntry { binding: 5, resource: cells.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 7, resource: grid.as_entire_binding() },
            ],
        });
        Ok(Self { pipes, group, texture, view, w, h, last_seq: None, cleared: false })
    }

    /// Projects the newest person tracking result (once per result); true if it did.
    pub fn update(&mut self, enc: &mut wgpu::CommandEncoder, k: &KinectData) -> bool {
        let seq = k.persons.as_ref().map(|p| p.seq);
        let stale = k.persons.is_none() || k.depth.is_none() || k.depth_age_ms() > 1000.0;
        if seq == self.last_seq && !stale {
            return false;
        }
        if stale && self.cleared {
            return false;
        }
        self.last_seq = seq;
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("wall-persons"), timestamp_writes: None });
        pass.set_bind_group(0, &self.group, &[]);
        if !stale {
            pass.set_pipeline(&self.pipes[0]);
            pass.dispatch_workgroups(512u32.div_ceil(8), 424u32.div_ceil(8), 1);
        }
        pass.set_pipeline(&self.pipes[1]);
        pass.dispatch_workgroups(self.w.div_ceil(8), self.h.div_ceil(8), 1);
        pass.set_pipeline(&self.pipes[2]);
        pass.dispatch_workgroups((self.w * self.h).div_ceil(64), 1, 1);
        drop(pass);
        self.cleared = stale;
        true
    }
}
