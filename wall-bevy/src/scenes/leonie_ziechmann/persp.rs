//! The people in perspective (persp.js), on top of the scene's projection (ctx.wall; the scene asks
//! for the view cone as its play field):
//!
//!   sideways  where the projection puts the person (by default the angle in the Kinect's view: far
//!             back one has to walk further to cross the wall, parallax like the sensor's view)
//!   size      shrinks with the distance (1 / z), the body keeps its proportions
//!   height    the feet rise towards the horizon the farther away someone stands, onto the farther
//!             hills of the wood
//!   depth     with `back` the people walk only in the back of the wood: the play field's depth
//!             (front 0 .. back 1, with the projection's depth curve) becomes a depth in the wood
//!             (back[0]..back[1], e.g. 3.0..5.5 m); size, feet and the order between the trees
//!             follow that depth
//!
//! Every person is placed as a whole: its body center gives the place and the scale, its pixels are
//! drawn around it. Perspective computes the per-person placement on the CPU and also hands it to
//! the leaves, the heap and the body field; PerspPersons projects the person pixels into a texture
//! on the GPU like wall_persons.rs (r covered, g depth in the wood, b slot, a IR).

use std::collections::HashMap;

use crate::gpu::{Gpu, GpuResult, layout};
use crate::kinect::KinectData;
use crate::kinect_gpu::KinectGpu;
use crate::params::Params;
use crate::wall::{WallMap, wall_wgsl};

const CELL_PX: u32 = 2;
pub const SLOTS: usize = 17;

/// A person on the wall this frame (wall m, like ctx.wall.persons, plus the depth in the wood).
#[derive(Clone, Copy, Debug)]
pub struct Place {
    pub id: u32,
    pub x: f64,
    pub feet: f64,
    pub top: f64,
    pub vx: f64,
    /// m from the sensor (real)
    pub dist: f64,
}

/// The placement as the body field needs it: per slot x px, feet px, px per m, lat; depth shift (as
/// the GPU reads them), and the wall's scale.
#[derive(Clone)]
pub struct Placing {
    pub slots: [f32; SLOTS * 8],
    kx: f32,
    ky: f32,
    top: f32,
}

impl Placing {
    /// a person pixel of `slot` at room (lat, y) -> wall m [x, y], or None
    pub fn project(&self, slot: u8, lat: f32, ry: f32) -> Option<[f32; 2]> {
        let o = slot as usize * 8;
        let v = self.slots.get(o..o + 4)?;
        let scale = v[2];
        if scale == 0.0 {
            return None;
        }
        Some([(v[0] + (lat - v[3]) * scale) / self.kx, self.top - (v[1] - ry * scale) / self.ky])
    }
}

pub struct Perspective {
    /// id -> (x, vx) smoothed, for the speed across the wall
    track: HashMap<u32, (f64, f64)>,
    pub places: Vec<Place>,
    pub place: Placing,
    kx: f64,
    ky: f64,
    top: f64,
    a: f64,
    yh: f64,
    f: f64,
    min_z: f64,
    back: Option<[f64; 2]>,
    seen: Vec<u32>,
}

impl Perspective {
    pub fn new() -> Self {
        Self {
            track: HashMap::new(),
            places: Vec::new(),
            place: Placing { slots: [0.0; SLOTS * 8], kx: 1.0, ky: 1.0, top: 2.0 },
            kx: 1.0,
            ky: 1.0,
            top: 2.0,
            a: 0.0,
            yh: 0.0,
            f: 1.0,
            min_z: 0.8,
            back: None,
            seen: Vec::new(),
        }
    }

    /// p: the params (nearSize: size at the near anchor, 1 = real; backWood...), feet: two anchors
    /// [[z m, y design px], ...] where the feet stand (on the wood's ground).
    pub fn configure(&mut self, p: &Params, w: f64, h: f64, s: f64, wall: &WallMap, feet: [[f64; 2]; 2]) {
        let st = &wall.setup;
        let (size_w, size_h) = (f64::from(st.size_w), f64::from(st.size_h));
        self.kx = w / size_w;
        self.ky = h / size_h;
        self.top = f64::from(st.bottom) + size_h;
        (self.place.kx, self.place.ky, self.place.top) = (self.kx as f32, self.ky as f32, self.top as f32);
        let px_per_m = h / size_h;
        let [[near_z, y_near], [far_z, y_far]] = feet;
        // feet: y = yh + A / z (a pinhole looking along the floor); size: scale = f / z (px per m)
        self.a = ((y_near - y_far) * s) / (1.0 / near_z - 1.0 / far_z);
        self.yh = y_far * s - self.a / far_z;
        self.f = p.f64("nearSize") * px_per_m * near_z;
        self.min_z = 0.8;
        // only in the back of the wood: the play field's depth -> back[0]..back[1]
        self.back = if p.b("backWood") { Some([p.f64("backNear"), (p.f64("backNear") + 0.1).max(p.f64("backFar"))]) } else { None };
    }

    /// the depth in the wood (m) of a person: from the play field's depth, or the real distance
    fn depth(&self, dist: f64, norm_z: f64) -> f64 {
        match self.back {
            None => dist,
            Some([b0, b1]) => (b0 - 0.05).max(b0 + norm_z * (b1 - b0)),
        }
    }

    /// The people of this frame: per visible person its placement and the GPU slot data.
    pub fn update(&mut self, wall: &WallMap, dt: f64) {
        let dt = dt.clamp(1e-3, 0.1);
        self.place.slots.fill(0.0);
        self.places.clear();
        self.seen.clear();
        let side = f64::from(wall.side());
        for pl in &wall.persons {
            if !pl.in_zone {
                continue;
            }
            let lat = side * f64::from(pl.room.x);
            let z = f64::from(pl.room.z);
            let zv = self.depth(f64::from(pl.dist), f64::from(pl.norm.z)).max(self.min_z);
            let (qx, qfeet, qscale) = (f64::from(pl.x) * self.kx, self.yh + self.a / zv, self.f / zv);
            let xm = qx / self.kx;
            let vx = match self.track.get_mut(&pl.id) {
                None => {
                    self.track.insert(pl.id, (xm, 0.0));
                    0.0
                }
                Some(tr) => {
                    let a = 1.0 - (-dt / 0.25).exp();
                    tr.1 += ((xm - tr.0) / dt - tr.1) * a;
                    tr.0 = xm;
                    tr.1
                }
            };
            self.seen.push(pl.id);
            let feet_m = self.top - qfeet / self.ky;
            let head_h = f64::from(pl.top - pl.feet).max(0.5); // real height of the head above the feet
            let sc = qscale / self.ky; // m on the wall per m of the person
            self.places.push(Place { id: pl.id, x: xm, feet: feet_m, top: feet_m + head_h * sc, vx, dist: z });
            let slot = pl.slot as usize;
            if slot > 0 && slot < SLOTS {
                self.place.slots[slot * 8..slot * 8 + 8].copy_from_slice(&[qx as f32, qfeet as f32, qscale as f32, lat as f32, (zv - z) as f32, 0.0, 0.0, 0.0]);
            }
        }
        let seen = &self.seen;
        self.track.retain(|id, _| seen.contains(id));
    }
}

fn wgsl() -> String {
    format!(
        r"{wall}
@group(0) @binding(1) var personLabel: texture_2d<u32>;
@group(0) @binding(2) var personDepth: texture_2d<f32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var irTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> cells: array<atomic<u32>>;
@group(0) @binding(6) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var<uniform> grid: vec4u; // cells wide, high, LED px per cell
@group(0) @binding(8) var<uniform> place: array<vec4f, {slots2}>; // per slot: x px, feet px, px per m, lat of the center; depth shift

const EMPTY = 0xffffffffu;

// every person pixel -> its cell around its person's place; the nearest point wins
@compute @workgroup_size(8, 8)
fn scatter(@builtin(global_invocation_id) id: vec3u) {{
  let size = textureDimensions(personDepth);
  if (id.x >= size.x || id.y >= size.y) {{ return; }}
  let p = vec2i(id.xy);
  let slot = textureLoad(personLabel, p, 0).r;
  let z = textureLoad(personDepth, p, 0).r;
  if (slot == 0u || z < 0.1) {{ return; }}
  let a = place[min(slot, {last}u) * 2u];
  let dz = place[min(slot, {last}u) * 2u + 1u].x;
  if (a.z <= 0.0) {{ return; }}
  let ray = textureLoad(lutTex, p, 0).rg;
  let world = vec3f(WALL.xSign * ray.x * z, -ray.y * z, z);
  let room = wallRoom(world);
  if (!wallInZone(room)) {{ return; }}
  let lat = WALL.side * room.x;
  let px = vec2f(a.x + (lat - a.w) * a.z, a.y - room.y * a.z);
  let c = vec2i(floor(px / f32(grid.z)));
  if (any(c < vec2i(0)) || any(c >= vec2i(grid.xy))) {{ return; }}
  let mm = u32(clamp(room.z + dz, 0.0, 60.0) * 1000.0);
  let ir = u32(saturate(textureLoad(irTex, p, 0).r) * 255.0);
  atomicMin(&cells[u32(c.y) * grid.x + u32(c.x)], (mm << 13u) | (ir << 5u) | min(slot, 31u));
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
        wall = wall_wgsl(0, 0),
        slots2 = SLOTS * 2,
        last = SLOTS - 1,
    )
}

/// The person pixels in perspective, as a texture over the LED image (createPerspPersons).
pub struct PerspPersons {
    pipes: [wgpu::ComputePipeline; 3],
    bgl: wgpu::BindGroupLayout,
    views: [wgpu::TextureView; 4],
    wall_buf: wgpu::Buffer,
    grid_buf: wgpu::Buffer,
    place_buf: wgpu::Buffer,
    group: wgpu::BindGroup,
    _cells: wgpu::Buffer,
    _texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub w: u32,
    pub h: u32,
    last_seq: Option<u32>,
    cleared: bool,
}

impl PerspPersons {
    pub fn new(gpu: &Gpu, kg: &KinectGpu, wall_buf: &wgpu::Buffer, led: [u32; 2]) -> GpuResult<Self> {
        let module = gpu.shader("leonie-ziechmann: persp", &wgsl())?;
        let c = wgpu::ShaderStages::COMPUTE;
        let bgl = gpu.bind_group_layout(
            "leonie-ziechmann persp",
            &[
                layout::uniform(0, c),
                layout::uint_tex(1, c),
                layout::float_tex(2, c, false),
                layout::float_tex(3, c, false),
                layout::float_tex(4, c, true),
                layout::storage(5, c, false),
                layout::storage_tex(6, c, wgpu::TextureFormat::Rgba16Float),
                layout::uniform(7, c),
                layout::uniform(8, c),
            ],
        );
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("leonie-ziechmann persp"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let mk = |entry: &str| {
            gpu.compute_pipeline(&format!("leonie-ziechmann persp {entry}"), |d| {
                d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some(entry), layout: Some(&pl), module: &module, entry_point: Some(entry), compilation_options: Default::default(), cache: None })
            })
        };
        let pipes = [mk("scatter")?, mk("resolve")?, mk("clear")?];
        let grid_buf = gpu.uniform_buffer("leonie-ziechmann persp grid", 16);
        let place_buf = gpu.uniform_buffer("leonie-ziechmann persp place", (SLOTS * 32) as u64);
        let views = [kg.person_label_texture(), kg.person_depth_texture(), kg.lut_texture(), kg.ir_texture()];
        let (w, h) = grid_size(led);
        let (cells, texture, view, group) = Self::resources(gpu, &bgl, &views, wall_buf, &grid_buf, &place_buf, w, h);
        Ok(Self { pipes, bgl, views, wall_buf: wall_buf.clone(), grid_buf, place_buf, group, _cells: cells, _texture: texture, view, w, h, last_seq: None, cleared: false })
    }

    #[allow(clippy::too_many_arguments)]
    fn resources(gpu: &Gpu, bgl: &wgpu::BindGroupLayout, views: &[wgpu::TextureView; 4], wall_buf: &wgpu::Buffer, grid_buf: &wgpu::Buffer, place_buf: &wgpu::Buffer, w: u32, h: u32) -> (wgpu::Buffer, wgpu::Texture, wgpu::TextureView, wgpu::BindGroup) {
        let cells = gpu.storage_buffer("leonie-ziechmann persp cells", u64::from(w * h) * 4);
        gpu.queue.write_buffer(&cells, 0, bytemuck::cast_slice(&vec![0xffff_ffffu32; (w * h) as usize]));
        let texture = gpu.texture("leonie-ziechmann persp", w, h, wgpu::TextureFormat::Rgba16Float, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING);
        let view = texture.create_view(&Default::default());
        gpu.queue.write_buffer(grid_buf, 0, bytemuck::cast_slice(&[w, h, CELL_PX, 0]));
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("leonie-ziechmann persp"),
            layout: bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wall_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&views[0]) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&views[1]) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&views[2]) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&views[3]) },
                wgpu::BindGroupEntry { binding: 5, resource: cells.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 7, resource: grid_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 8, resource: place_buf.as_entire_binding() },
            ],
        });
        (cells, texture, view, group)
    }

    /// The grid follows the wall's LED size (a new setup); true if it was made anew.
    pub fn ensure(&mut self, gpu: &Gpu, led: [u32; 2]) -> bool {
        let (w, h) = grid_size(led);
        if w == self.w && h == self.h {
            return false;
        }
        let (cells, texture, view, group) = Self::resources(gpu, &self.bgl, &self.views, &self.wall_buf, &self.grid_buf, &self.place_buf, w, h);
        self._cells = cells;
        self._texture = texture;
        self.view = view;
        self.group = group;
        self.w = w;
        self.h = h;
        self.last_seq = None;
        true
    }

    /// Projects the newest person result with the placements `slots` (Perspective.slots).
    pub fn update(&mut self, gpu: &Gpu, enc: &mut wgpu::CommandEncoder, k: &KinectData, slots: &[f32; SLOTS * 8]) -> bool {
        let seq = k.persons.as_ref().map(|p| p.seq);
        let stale = k.persons.is_none() || k.depth.is_none() || k.depth_age_ms() > 1000.0;
        if seq == self.last_seq && !stale {
            return false;
        }
        if stale && self.cleared {
            return false;
        }
        self.last_seq = seq;
        gpu.queue.write_buffer(&self.place_buf, 0, bytemuck::cast_slice(slots));
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("leonie-ziechmann persp"), timestamp_writes: None });
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

fn grid_size(led: [u32; 2]) -> (u32, u32) {
    ((led[0] as f32 / CELL_PX as f32).round().max(8.0) as u32, (led[1] as f32 / CELL_PX as f32).round().max(8.0) as u32)
}
