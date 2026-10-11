//! Drawing, as pixel art (render.js): everything is rendered into an "art" texture at the art
//! resolution (one art pixel = P x P LEDs), then snapped to the palette (pixel.rs), with ordered
//! dithering where colors fall between palette entries (glows), and scaled up without smoothing
//! onto the LED image.
//!
//!   1. sprites behind the people: the painted backdrop, stars, lit windows, glows, blossom crowns,
//!      lanterns, petals on the ground
//!   2. the people: pixel figures with a dark outline, cel tones from the infrared image, a warm
//!      rim light from above (the lanterns), each person in their own palette
//!   3. sprites in front: petals in the air and on the people, the QR card's frame, the text layer
//!
//! Every sprite is an instance of one quad: x, y, half width, half height (art px), rotation, kind,
//! two kind params, rgba, uv rect. Shapes have hard edges; glows add up and get dithered.
//!
//! The browser snapped every LED pixel to the palette; the result depends only on the art pixel,
//! so here the palette pass runs once per art pixel and a last pass scales it up (the same image,
//! a quarter of the work at 2 x 2 LEDs per art pixel).

use crate::gpu::{Gpu, TARGET_FORMAT, layout};
use crate::kinect::KinectData;
use crate::kinect_gpu::KinectGpu;
use crate::wall_persons::WallPersons;

use super::pixel::{PALETTE, Pix, c::*, rgb, rgb64};

pub const FLOATS: usize = 16;
pub const KIND_ATLAS: f32 = 0.0;
pub const KIND_DISC: f32 = 1.0;
pub const KIND_GLOW: f32 = 3.0;
pub const KIND_PAINT: f32 = 4.0;
pub const KIND_OVERLAY: f32 = 5.0;
pub const KIND_RECT: f32 = 7.0;
/// the shown subline (from its atlas, p1 p2: offset into it)
pub const KIND_SUB: f32 = 8.0;
/// cords and QR card, over the subline
pub const KIND_OVER: f32 = 9.0;

/// instances the buffer holds at first (a few thousand are drawn)
const CAPACITY: usize = 8192;
const ART: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// The instances of a frame (main.js Writer).
pub struct Writer {
    pub data: Vec<f32>,
}

impl Writer {
    pub fn new() -> Self {
        Self { data: Vec::with_capacity(CAPACITY * FLOATS) }
    }

    pub fn len(&self) -> usize {
        self.data.len() / FLOATS
    }

    /// q: x, y, half width, half height; p: the kind's params; uv: atlas rect (default 0..1).
    pub fn push(&mut self, q: [f64; 4], kind: f32, p: [f64; 2], c: [f32; 3], a: f64, uv: Option<[f32; 4]>) {
        let uv = uv.unwrap_or([0.0, 0.0, 1.0, 1.0]);
        self.data.extend_from_slice(&[
            q[0] as f32,
            q[1] as f32,
            q[2] as f32,
            q[3] as f32,
            0.0,
            kind,
            p[0] as f32,
            p[1] as f32,
            c[0],
            c[1],
            c[2],
            a as f32,
            uv[0],
            uv[1],
            uv[2],
            uv[3],
        ]);
    }
}

/// a palette per person slot: shadow, mid, light
const PEOPLE: [[u32; 3]; 6] = [[SKY4, SKY8, SKY10], [SKY4, C1, C2], [SKY4, P3, P5], [SKY4, B0, B1], [SKY4, SKY9, SKY11], [SKY4, G4, G6]];

/// OKLab of the palette, for the nearest-color search
fn oklab([r, g, b]: [f64; 3]) -> [f64; 3] {
    let lin = |c: f64| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
    let (r, g, b) = (lin(r), lin(g), lin(b));
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    [
        0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
        1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
        0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
    ]
}

fn v3(c: u32) -> String {
    let v = rgb(c);
    format!("vec3f({:.4}, {:.4}, {:.4})", v[0], v[1], v[2])
}

fn array(list: &[String]) -> String {
    format!("array<vec3f, {}>({})", list.len(), list.join(", "))
}

const WGSL: &str = r"
struct U {
  art: vec2f,        // art resolution
  time: f32,
  style: f32,        // people: 0 pixel figures, 1 silhouettes
  people: vec4f,     // brightness (unused), rim, IR gain, outline
  post: vec4f,       // LEDs per art pixel, dither amount
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var paintTex: texture_2d<f32>;
@group(0) @binding(3) var atlasTex: texture_2d<f32>;
@group(0) @binding(4) var overlayTex: texture_2d<f32>;
@group(0) @binding(5) var personTex: texture_2d<f32>;
@group(0) @binding(6) var artTex: texture_2d<f32>;
@group(0) @binding(7) var subTex: texture_2d<f32>;   // the sublines (overlay)
@group(0) @binding(8) var overTex: texture_2d<f32>;  // cords and QR card (overlay, on top)

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) @interpolate(flat) kind: f32,
  @location(2) col: vec4f,
  @location(3) uv: vec2f,
  @location(4) prm: vec4f, // half width, half height (px), p1, p2
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) d: vec4f) -> VOut {
  var corner = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let q = corner[vi];
  let local = q * a.zw;
  let cs = vec2f(cos(b.x), sin(b.x));
  let p = a.xy + vec2f(local.x * cs.x - local.y * cs.y, local.x * cs.y + local.y * cs.x);
  var out: VOut;
  out.pos = vec4f(p.x / u.art.x * 2.0 - 1.0, 1.0 - p.y / u.art.y * 2.0, 0.0, 1.0);
  out.q = q;
  out.kind = b.y;
  out.col = c;
  out.uv = mix(d.xy, d.zw, q * 0.5 + 0.5);
  out.prm = vec4f(a.zw, b.zw);
  return out;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let k = u32(in.kind + 0.5);
  switch k {
    case 0u: { // atlas sprite (premultiplied), tinted
      return textureSampleLevel(atlasTex, samp, in.uv, 0.0) * in.col;
    }
    case 1u: { // disc with a hard edge: radius p1 (px)
      let p = in.q * in.prm.xy;
      if (dot(p, p) > in.prm.z * in.prm.z) { return vec4f(0.0); }
      return vec4f(in.col.rgb, 1.0) * in.col.a;
    }
    case 3u: { // glow, additive (dithered into steps by the palette pass)
      let f = saturate(1.0 - length(in.q));
      return vec4f(in.col.rgb * (f * f) * in.col.a, 0.0);
    }
    case 4u: { return textureLoad(paintTex, vec2i(in.pos.xy), 0); }
    case 5u: { return textureLoad(overlayTex, vec2i(in.pos.xy), 0); }
    case 6u: { // streak (shooting star): bright head at +x, additive
      let along = saturate(in.q.x * 0.5 + 0.5);
      return vec4f(in.col.rgb * along * along * in.col.a, 0.0);
    }
    case 7u: { return vec4f(in.col.rgb, 1.0) * in.col.a; } // rect
    case 8u: { return textureLoad(subTex, vec2i(in.pos.xy) + vec2i(round(in.prm.zw)), 0); }
    case 9u: { return textureLoad(overTex, vec2i(in.pos.xy), 0); }
    default: { return vec4f(0.0); }
  }
}

// ---------- the people (art resolution)

@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

const PEOPLE_SHADOW = {PEOPLE_SHADOW};
const PEOPLE_MID = {PEOPLE_MID};
const PEOPLE_LIGHT = {PEOPLE_LIGHT};
const OUTLINE = {OUTLINE};
const RIM = {RIM};
const RIM2 = {RIM2};
const SIL = {SIL};

// the person texture at an art pixel: x covered, y IR (0 if not covered), z slot
fn cell(p: vec2i) -> vec3f {
  let dims = vec2i(textureDimensions(personTex));
  let t = textureLoad(personTex, clamp(vec2i((vec2f(p) + 0.5) / u.art * vec2f(dims)), vec2i(0), dims - 1), 0);
  return vec3f(step(0.5, t.r), t.a * step(0.5, t.r), t.b);
}
// covered, smoothed: a pixel is in if most of its 3 x 3 block is (no single-pixel teeth)
fn inside(p: vec2i) -> bool {
  var n = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) { n += cell(p + vec2i(x, y)).x; }
  }
  let c = cell(p).x;
  return (c > 0.5 && n >= 4.0) || n >= 6.0;
}

@fragment fn fsPeople(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let me = inside(p);
  if (!me) {
    // the outline: one dark pixel around every figure
    let near = inside(p + vec2i(1, 0)) || inside(p - vec2i(1, 0)) || inside(p + vec2i(0, 1)) || inside(p - vec2i(0, 1));
    if (near && u.people.w > 0.5) { return vec4f(OUTLINE, 1.0); }
    return vec4f(0.0);
  }
  // the slot, the infrared here (3 x 3) and around (5 x 5), covered pixels only
  var slot = 0.0;
  var ir = 0.0;
  var n = 0.0;
  var irAll = 0.0;
  var nAll = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let c = cell(p + vec2i(x, y));
      irAll += c.y;
      nAll += c.x;
      if (abs(x) <= 1 && abs(y) <= 1) {
        ir += c.y;
        n += c.x;
        slot = max(slot, c.z);
      }
    }
  }
  let s = u32(slot + 0.5) % {PEOPLE_N}u;
  // light and shadow from the detail of the infrared image: brighter than around = light,
  // darker = shadow (faces, hair, folds), independent of how far away someone stands
  let d = (ir / max(n, 1.0) - irAll / max(nAll, 1.0)) * u.people.z;
  // cel shading: the light comes from the upper left (the lanterns). A band along the left and
  // upper edges is lit, a band along the right is in shadow, the infrared detail adds a step
  let lit = !inside(p + vec2i(-3, -1)) || !inside(p + vec2i(-1, -3));
  let away = !inside(p + vec2i(4, 1)) || !inside(p + vec2i(2, 4));
  var tone = select(select(1, 2, lit), 0, away && !lit);
  tone = clamp(tone + select(select(0, 1, d > 0.045), -1, d < -0.045), 0, 2);
  let open1 = !inside(p + vec2i(0, -1)) || !inside(p + vec2i(-1, -1));
  let open2 = !inside(p + vec2i(0, -2));
  var col = select(select(PEOPLE_SHADOW[s], PEOPLE_MID[s], tone == 1), PEOPLE_LIGHT[s], tone == 2);
  if (u.style > 0.5) { col = SIL; }
  if (u.people.y > 0.0) {
    if (open1) { col = select(RIM, RIM2, u.people.y > 0.75); }
    else if (open2 && u.people.y > 0.5) { col = RIM; }
  }
  return vec4f(col, 1.0);
}

// ---------- art -> palette (dithered between entries) -> LED image

const PAL = {PAL};
const PAL_LAB = {PAL_LAB};
const BAYER = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

fn toLab(c: vec3f) -> vec3f {
  let lin = select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
  let l = pow(max(0.0, 0.4122214708 * lin.r + 0.5363325363 * lin.g + 0.0514459929 * lin.b), 1.0 / 3.0);
  let m = pow(max(0.0, 0.2119034982 * lin.r + 0.6806995451 * lin.g + 0.1073969566 * lin.b), 1.0 / 3.0);
  let s = pow(max(0.0, 0.0883024619 * lin.r + 0.2817188376 * lin.g + 0.6299787005 * lin.b), 1.0 / 3.0);
  return vec3f(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
fn nearest(c: vec3f) -> vec2f { // index, squared distance
  let lab = toLab(c);
  var best = 0.0;
  var bd = 1e9;
  for (var i = 0u; i < {PAL_N}u; i++) {
    let d = lab - PAL_LAB[i];
    let dd = dot(d, d * vec3f(1.0, 1.4, 1.4));
    if (dd < bd) { bd = dd; best = f32(i); }
  }
  return vec2f(best, bd);
}

// the palette, once per art pixel (render.js fsPost at the LED pixels of an art pixel)
@fragment fn fsPalette(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ap = vec2i(floor(pos.xy));
  let c = textureLoad(artTex, ap, 0).rgb;
  var n = nearest(c);
  if (n.y > 0.00002 && u.post.y > 0.0) {
    let b = (BAYER[(ap.y & 3) * 4 + (ap.x & 3)] + 0.5) / 16.0 - 0.5;
    n = nearest(saturate(c + vec3f(b * 0.11 * u.post.y)));
  }
  return vec4f(PAL[u32(n.x)], 1.0);
}

// art -> LED image: scaled up without smoothing
@fragment fn fsPost(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(artTex, vec2i(floor(pos.xy / u.post.x)), 0);
}
";

fn wgsl() -> String {
    let people = |k: usize| array(&PEOPLE.iter().map(|p| v3(p[k])).collect::<Vec<_>>());
    let pal = array(&PALETTE.iter().map(|&c| v3(c)).collect::<Vec<_>>());
    let lab = array(
        &PALETTE
            .iter()
            .map(|&c| {
                let l = oklab(rgb64(c));
                format!("vec3f({:.5}, {:.5}, {:.5})", l[0], l[1], l[2])
            })
            .collect::<Vec<_>>(),
    );
    WGSL.replace("{PEOPLE_SHADOW}", &people(0))
        .replace("{PEOPLE_MID}", &people(1))
        .replace("{PEOPLE_LIGHT}", &people(2))
        .replace("{PEOPLE_N}", &PEOPLE.len().to_string())
        .replace("{OUTLINE}", &v3(SKY0))
        .replace("{RIM}", &v3(O5))
        .replace("{RIM2}", &v3(Y1))
        .replace("{SIL}", &v3(SKY1))
        .replace("{PAL_LAB}", &lab)
        .replace("{PAL_N}", &PALETTE.len().to_string())
        .replace("{PAL}", &pal)
}

/// What a frame's uniforms carry (render() p of render.js).
pub struct Look {
    pub aw: u32,
    pub ah: u32,
    pub scale: u32,
    pub time: f32,
    pub dither: f32,
    pub style: f32,
    pub rim: f32,
    pub ir_gain: f32,
    pub outline: f32,
}

/// The art-sized layers and what is bound with them.
struct Layers {
    w: u32,
    h: u32,
    paint: wgpu::Texture,
    overlay: wgpu::Texture,
    over: wgpu::Texture,
    /// the frame at the art resolution, then snapped to the palette (the views keep the textures)
    art_view: wgpu::TextureView,
    snap_view: wgpu::TextureView,
}

pub struct Renderer {
    sprite_pipe: wgpu::RenderPipeline,
    people_pipe: wgpu::RenderPipeline,
    palette_pipe: wgpu::RenderPipeline,
    post_pipe: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    uni: wgpu::Buffer,
    sampler: wgpu::Sampler,
    atlas: wgpu::Texture,
    dummy: wgpu::Texture,
    sub: wgpu::Texture,
    layers: Layers,
    /// [drawing the art (no art texture bound), the palette pass, scaling up]
    groups: [wgpu::BindGroup; 3],
    inst: wgpu::Buffer,
    inst_cap: usize,
    persons: WallPersons,
}

fn usage() -> wgpu::TextureUsages {
    wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::RENDER_ATTACHMENT
}

impl Renderer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(gpu: &Gpu, kg: &KinectGpu, wall_buf: &wgpu::Buffer, led: [u32; 2], atlas_pix: &Pix, aw: u32, ah: u32, sub_pix: &Pix) -> Result<Self, String> {
        let module = gpu.shader("llg-sakura: render", &wgsl())?;
        let persons = WallPersons::new(gpu, kg, wall_buf, led)?;
        let vf = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
        let mut entries = vec![layout::uniform(0, vf), layout::sampler(1, vf, true)];
        entries.extend((2..=8).map(|b| layout::float_tex(b, vf, true)));
        let bgl = gpu.bind_group_layout("llg-sakura render", &entries);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("llg-sakura"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let premul = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let blend = Some(wgpu::BlendState { color: premul, alpha: premul });
        let attrs: Vec<wgpu::VertexAttribute> = (0..4).map(|i| wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: i * 16, shader_location: i as u32 }).collect();
        let pipe = |key: &str, vs: &str, fs: &str, instanced: bool, format: wgpu::TextureFormat, blend: Option<wgpu::BlendState>| {
            gpu.render_pipeline(key, |d| {
                let buffers = [Some(wgpu::VertexBufferLayout { array_stride: (FLOATS * 4) as u64, step_mode: wgpu::VertexStepMode::Instance, attributes: &attrs })];
                d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(key),
                    layout: Some(&pl),
                    vertex: wgpu::VertexState { module: &module, entry_point: Some(vs), compilation_options: Default::default(), buffers: if instanced { &buffers } else { &[] } },
                    fragment: Some(wgpu::FragmentState {
                        module: &module,
                        entry_point: Some(fs),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                })
            })
        };
        let sprite_pipe = pipe("llg-sakura sprites", "vs", "fs", true, ART, blend)?;
        let people_pipe = pipe("llg-sakura people", "vsFull", "fsPeople", false, ART, blend)?;
        let palette_pipe = pipe("llg-sakura palette", "vsFull", "fsPalette", false, ART, None)?;
        let post_pipe = pipe("llg-sakura post", "vsFull", "fsPost", false, TARGET_FORMAT, None)?;
        let uni = gpu.uniform_buffer("llg-sakura u", 48);
        let sampler = gpu.nearest_sampler();
        let atlas = gpu.texture("llg-sakura atlas", atlas_pix.w as u32, atlas_pix.h as u32, ART, usage());
        gpu.write_texture(&atlas, atlas_pix.bytes(), 4);
        let dummy = gpu.texture("llg-sakura dummy", 1, 1, ART, wgpu::TextureUsages::TEXTURE_BINDING);
        let sub = gpu.texture("llg-sakura sublines", sub_pix.w as u32, sub_pix.h as u32, ART, usage());
        gpu.write_texture(&sub, sub_pix.bytes(), 4);
        let layers = Self::layers(gpu, aw, ah);
        let groups = Self::groups(gpu, &bgl, &uni, &sampler, &atlas, &dummy, &sub, &layers, &persons);
        let inst = gpu.buffer("llg-sakura sprites", (CAPACITY * FLOATS * 4) as u64, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
        Ok(Self { sprite_pipe, people_pipe, palette_pipe, post_pipe, bgl, uni, sampler, atlas, dummy, sub, layers, groups, inst, inst_cap: CAPACITY, persons })
    }

    fn layers(gpu: &Gpu, w: u32, h: u32) -> Layers {
        let t = |label: &str| gpu.texture(label, w, h, ART, usage());
        let art_view = t("llg-sakura art").create_view(&Default::default());
        let snap_view = t("llg-sakura palette").create_view(&Default::default());
        Layers { w, h, paint: t("llg-sakura paint"), overlay: t("llg-sakura overlay"), over: t("llg-sakura over"), art_view, snap_view }
    }

    #[allow(clippy::too_many_arguments)]
    fn groups(gpu: &Gpu, bgl: &wgpu::BindGroupLayout, uni: &wgpu::Buffer, sampler: &wgpu::Sampler, atlas: &wgpu::Texture, dummy: &wgpu::Texture, sub: &wgpu::Texture, l: &Layers, persons: &WallPersons) -> [wgpu::BindGroup; 3] {
        let view = |t: &wgpu::Texture| t.create_view(&Default::default());
        let (paint, atlas, overlay, sub, over, dummy) = (view(&l.paint), view(atlas), view(&l.overlay), view(sub), view(&l.over), view(dummy));
        let make = |art: &wgpu::TextureView| {
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("llg-sakura"),
                layout: bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: uni.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&paint) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&atlas) },
                    wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&overlay) },
                    wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&persons.view) },
                    wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(art) },
                    wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::TextureView(&sub) },
                    wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::TextureView(&over) },
                ],
            })
        };
        [make(&dummy), make(&l.art_view), make(&l.snap_view)]
    }

    fn rebind(&mut self, gpu: &Gpu) {
        self.groups = Self::groups(gpu, &self.bgl, &self.uni, &self.sampler, &self.atlas, &self.dummy, &self.sub, &self.layers, &self.persons);
    }

    /// The art-sized layers for this size (new textures only when it changed).
    fn ensure(&mut self, gpu: &Gpu, w: u32, h: u32) {
        if self.layers.w != w || self.layers.h != h {
            self.layers = Self::layers(gpu, w, h);
            self.rebind(gpu);
        }
    }

    fn upload(gpu: &Gpu, tex: &wgpu::Texture, pix: &Pix) {
        let s = tex.size();
        if s.width as usize == pix.w && s.height as usize == pix.h {
            gpu.write_texture(tex, pix.bytes(), 4);
        }
    }

    /// The painted backdrop (art size).
    pub fn upload_paint(&mut self, gpu: &Gpu, pix: &Pix) {
        self.ensure(gpu, pix.w as u32, pix.h as u32);
        Self::upload(gpu, &self.layers.paint, pix);
    }

    /// The text layer: under the subline, the sublines' atlas, over the subline.
    pub fn upload_overlay(&mut self, gpu: &Gpu, under: &Pix, subs: &Pix, over: &Pix) {
        self.ensure(gpu, under.w as u32, under.h as u32);
        Self::upload(gpu, &self.layers.overlay, under);
        Self::upload(gpu, &self.layers.over, over);
        let s = self.sub.size();
        if s.width as usize != subs.w || s.height as usize != subs.h {
            self.sub = gpu.texture("llg-sakura sublines", subs.w as u32, subs.h as u32, ART, usage());
            self.rebind(gpu);
        }
        Self::upload(gpu, &self.sub, subs);
    }

    /// Draws a frame: the instances (`back` of them behind the people), then the palette pass and
    /// the LED image into ctx.target.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, gpu: &Gpu, enc: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, k: &KinectData, w: &Writer, back: usize, look: &Look) {
        self.ensure(gpu, look.aw, look.ah);
        self.persons.update(enc, k);
        let total = w.len();
        if total > self.inst_cap {
            // more sprites than ever before (does not happen in practice): a larger buffer
            self.inst_cap = (total * 3 / 2).max(CAPACITY);
            self.inst = gpu.buffer("llg-sakura sprites", (self.inst_cap * FLOATS * 4) as u64, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
        }
        if total > 0 {
            gpu.queue.write_buffer(&self.inst, 0, bytemuck::cast_slice(&w.data[..total * FLOATS]));
        }
        let u: [f32; 12] = [look.aw as f32, look.ah as f32, look.time, look.style, 1.0, look.rim, look.ir_gain, look.outline, look.scale as f32, look.dither, 0.0, 0.0];
        gpu.queue.write_buffer(&self.uni, 0, bytemuck::cast_slice(&u));
        let back = back.min(total) as u32;
        let total = total as u32;
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("llg-sakura art"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.layers.art_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &self.groups[0], &[]);
            pass.set_pipeline(&self.sprite_pipe);
            pass.set_vertex_buffer(0, self.inst.slice(..));
            if back > 0 {
                pass.draw(0..6, 0..back);
            }
            pass.set_pipeline(&self.people_pipe);
            pass.draw(0..3, 0..1);
            if total > back {
                pass.set_pipeline(&self.sprite_pipe);
                pass.draw(0..6, back..total);
            }
        }
        {
            let mut pass = crate::gpu::begin_pass(enc, "llg-sakura palette", &self.layers.snap_view);
            pass.set_bind_group(0, &self.groups[1], &[]);
            pass.set_pipeline(&self.palette_pipe);
            pass.draw(0..3, 0..1);
        }
        let mut pass = crate::gpu::begin_pass(enc, "llg-sakura post", target);
        pass.set_bind_group(0, &self.groups[2], &[]);
        pass.set_pipeline(&self.post_pipe);
        pass.draw(0..3, 0..1);
    }
}
