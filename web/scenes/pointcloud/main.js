// Point cloud in the reference look: white, lit dots on dark gray with glow and vignette, seen from
// an orbiting camera (drag = rotate, wheel = zoom, space = auto orbit, r/double click = reset).
//
// Raw WebGPU. The hub sends depth (u16 mm) and once the undistortion table; the runtime keeps them
// in GPU buffers (ctx.kinect.gpu.*). Per pixel the vertex shader computes point = (x*z, y*z, z) and
// draws a lit sphere impostor into an additive r16float target; a blurred quarter-res copy of it is
// the glow; the composite pass tone-maps dots + glow onto the gray background.

import { checkedModule } from '/lib/shader-pass.js';

const W = 512;
const H = 424;

const POINTS_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  viewport: vec4f, // width, height, 1/width, 1/height
  p0: vec4f,       // dotFill, step, fx of the depth camera, focal length of the view in px
  p1: vec4f,       // fog a, fog b, xSign, ir mix
  grid: vec4u,     // cols, rows, step, unused
};
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> depth: array<u32>;  // u16 pairs
@group(0) @binding(2) var<storage, read> rays: array<vec2f>; // undistorted ray per pixel
@group(0) @binding(3) var<storage, read> ir: array<u32>;     // u8 quads

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) energy: f32,
  @location(2) radiusPx: f32,
};

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                                vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

fn depthAt(i: u32) -> u32 {
  let w = depth[i >> 1u];
  return select(w & 0xffffu, w >> 16u, (i & 1u) == 1u);
}

fn irAt(i: u32) -> f32 {
  let w = ir[i >> 2u];
  return f32((w >> ((i & 3u) * 8u)) & 0xffu) / 255.0;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var out: VSOut;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0); // outside the clip volume: not drawn
  out.uv = vec2f(0.0);
  out.energy = 0.0;
  out.radiusPx = 1.0;
  let step = U.grid.z;
  let col = (ii % U.grid.x) * step;
  let row = (ii / U.grid.x) * step;
  if (col >= 512u || row >= 424u) { return out; }
  let idx = row * 512u + col;
  let d = depthAt(idx);
  if (d == 0u) { return out; }
  let z = f32(d) * 0.001;
  let ray = rays[idx];
  // Kinect camera frame (x right, y down, z forward) -> world (x right, y up, z forward)
  let world = vec3f(ray.x * z * U.p1.z, -ray.y * z, z);
  let clip = U.viewProj * vec4f(world, 1.0);
  if (clip.w < 0.05) { return out; }
  // dot radius: a share of the footprint of one sensor pixel, projected into the view
  var rPx = U.p0.x * U.p0.y * z / U.p0.z * U.p0.w / clip.w;
  var energy = clamp(U.p1.x - U.p1.y * z, 0.3, 1.0); // depth fog
  let minPx = 0.8;
  if (rPx < minPx) { // tiny dots: draw at minimum size with less light instead of flickering
    energy *= rPx * rPx / (minPx * minPx);
    rPx = minPx;
  }
  if (U.p1.w > 0.0) { energy *= mix(1.0, 0.25 + 1.1 * irAt(idx), U.p1.w); }
  let corner = CORNERS[vi];
  let extent = rPx + 1.0; // one extra pixel for the anti-aliased edge
  out.pos = vec4f(clip.xy + corner * extent * 2.0 * U.viewport.zw * clip.w, clip.z, clip.w);
  out.uv = corner * (extent / rPx);
  out.energy = energy;
  out.radiusPx = rPx;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let d = length(in.uv);
  let cover = clamp((1.0 - d) * in.radiusPx + 0.5, 0.0, 1.0);
  if (cover <= 0.0) { discard; }
  var n = vec3f(in.uv, sqrt(max(0.0, 1.0 - d * d)));
  if (d >= 1.0) { n = vec3f(in.uv / d, 0.0); }
  let light = normalize(vec3f(-0.35, 0.55, 0.76)); // from the upper left, towards the viewer
  let shade = 0.28 + 0.72 * max(0.0, dot(n, light));
  return vec4f(in.energy * cover * shade, 0.0, 0.0, 1.0);
}
`;

const FULLSCREEN_WGSL = /* wgsl */ `
@vertex
fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
`;

const DOWN_WGSL = FULLSCREEN_WGSL + /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment
fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = (floor(fc.xy) * 4.0 + 2.0) / size; // center of the 4x4 source block
  let o = 1.0 / size;
  let s = textureSampleLevel(src, samp, uv + vec2f(-o.x, -o.y), 0.0).r
        + textureSampleLevel(src, samp, uv + vec2f(o.x, -o.y), 0.0).r
        + textureSampleLevel(src, samp, uv + vec2f(-o.x, o.y), 0.0).r
        + textureSampleLevel(src, samp, uv + vec2f(o.x, o.y), 0.0).r;
  return vec4f(s * 0.25, 0.0, 0.0, 1.0);
}
`;

const BLUR_WGSL = FULLSCREEN_WGSL + /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> dir: vec4f;
@fragment
fn fsBlur(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = fc.xy / size;
  let d = dir.xy / size;
  var s = textureSampleLevel(src, samp, uv, 0.0).r * 0.2270270270;
  s += (textureSampleLevel(src, samp, uv + d * 1.3846153846, 0.0).r
      + textureSampleLevel(src, samp, uv - d * 1.3846153846, 0.0).r) * 0.3162162162;
  s += (textureSampleLevel(src, samp, uv + d * 3.2307692308, 0.0).r
      + textureSampleLevel(src, samp, uv - d * 3.2307692308, 0.0).r) * 0.0702702703;
  return vec4f(s, 0.0, 0.0, 1.0);
}
`;

const COMPOSITE_WGSL = FULLSCREEN_WGSL + /* wgsl */ `
struct Post { dot: vec4f, bgCenter: vec4f, bgEdge: vec4f, gains: vec4f }; // gains: gain, glow
@group(0) @binding(0) var acc: texture_2d<f32>;
@group(0) @binding(1) var glow: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> P: Post;

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }

@fragment
fn fsComposite(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(acc));
  let uv = fc.xy / size;
  let a = textureLoad(acc, vec2i(fc.xy), 0).r;
  let g = textureSampleLevel(glow, samp, uv, 0.0).r;
  let f = uv - 0.5;
  let bg = mix(P.bgCenter.rgb, P.bgEdge.rgb, min(1.0, 2.0 * dot(f, f))); // gray with a soft vignette
  let dots = 1.0 - exp(-P.gains.x * a);
  let halo = 1.0 - exp(-P.gains.x * g);
  let c = bg + (P.dot.rgb - bg) * dots + P.gains.y * halo * (1.0 - dots) * P.dot.rgb + (hash(fc.xy) - 0.5) / 255.0;
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

const hex = (h) => {
  const v = Number.parseInt(String(h).slice(1), 16) || 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
};

let gpu = null;
let res = null; // pipelines, buffers, bind groups
let targets = null; // size-dependent textures
const uniforms = new ArrayBuffer(128);
const uf = new Float32Array(uniforms);
const uu = new Uint32Array(uniforms);

function ensureTargets(ctx) {
  const { device } = gpu;
  const w = ctx.width;
  const h = ctx.height;
  if (targets && targets.w === w && targets.h === h) return targets;
  targets?.textures.forEach((t) => t.destroy());
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  const acc = device.createTexture({ size: [w, h], format: 'r16float', usage });
  const qw = Math.max(1, Math.ceil(w / 4));
  const qh = Math.max(1, Math.ceil(h / 4));
  const q1 = device.createTexture({ size: [qw, qh], format: 'r16float', usage });
  const q2 = device.createTexture({ size: [qw, qh], format: 'r16float', usage });
  const bg = (pipeline, entries) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
  const s = res.sampler;
  targets = {
    w,
    h,
    textures: [acc, q1, q2],
    accView: acc.createView(),
    q1View: q1.createView(),
    q2View: q2.createView(),
    down: bg(res.down, [{ binding: 0, resource: acc.createView() }, { binding: 1, resource: s }]),
    blurH: bg(res.blur, [{ binding: 0, resource: q1.createView() }, { binding: 1, resource: s }, { binding: 2, resource: { buffer: res.blurBufs[0] } }]),
    blurV: bg(res.blur, [{ binding: 0, resource: q2.createView() }, { binding: 1, resource: s }, { binding: 2, resource: { buffer: res.blurBufs[1] } }]),
    composite: bg(res.composite, [
      { binding: 0, resource: acc.createView() },
      { binding: 1, resource: q1.createView() },
      { binding: 2, resource: s },
      { binding: 3, resource: { buffer: res.postBuf } },
    ]),
  };
  return targets;
}

export default {
  // the IR stream only while it is used
  streams: (p) => (p.irMix > 0 ? ['depth', 'ir'] : ['depth']),
  maxWidth: 2560,

  params: {
    dotFill: { value: 0.42, min: 0.1, max: 1.2, step: 0.01, label: 'Punktgröße' },
    step: { value: 2, options: { 'jedes Pixel': 1, 'jedes 2.': 2, 'jedes 3.': 3 }, label: 'Dichte' },
    gain: { value: 1.5, min: 0.2, max: 4, step: 0.05, label: 'Helligkeit' },
    glow: { value: 0.35, min: 0, max: 1.5, step: 0.01, label: 'Glow' },
    fog: { value: 0.2, min: 0, max: 0.5, step: 0.01, label: 'Tiefennebel' },
    irMix: { value: 0, min: 0, max: 1, step: 0.05, label: 'IR-Helligkeit' },
    dotColor: { value: '#ffffff', label: 'Punktfarbe', folder: 'Farben' },
    bgCenter: { value: '#2d2d2d', label: 'Hintergrund Mitte', folder: 'Farben' },
    bgEdge: { value: '#1d1d1d', label: 'Hintergrund Rand', folder: 'Farben' },
  },

  async setup(ctx) {
    gpu = await ctx.webgpu();
    const { device, format } = gpu;
    const kg = ctx.kinect.gpu; // depthBuffer, lutBuffer, irBuffer: kept up to date by the runtime
    const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const uniformBuf = device.createBuffer({ size: 128, usage: UNIFORM });
    const postBuf = device.createBuffer({ size: 64, usage: UNIFORM });
    const blurBufs = [
      [1.6, 0],
      [0, 1.6],
    ].map((d) => {
      const b = device.createBuffer({ size: 16, usage: UNIFORM });
      device.queue.writeBuffer(b, 0, new Float32Array([d[0], d[1], 0, 0]));
      return b;
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const additive = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
    const pointsModule = await checkedModule(device, POINTS_WGSL, 'pointcloud points');
    const points = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: pointsModule, entryPoint: 'vs' },
      fragment: { module: pointsModule, entryPoint: 'fs', targets: [{ format: 'r16float', blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });
    const fullscreen = async (code, entryPoint, targetFormat) => {
      const module = await checkedModule(device, code, `pointcloud ${entryPoint}`);
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vsFull' },
        fragment: { module, entryPoint, targets: [{ format: targetFormat }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    res = {
      uniformBuf,
      postBuf,
      blurBufs,
      sampler,
      points,
      down: await fullscreen(DOWN_WGSL, 'fsDown', 'r16float'),
      blur: await fullscreen(BLUR_WGSL, 'fsBlur', 'r16float'),
      composite: await fullscreen(COMPOSITE_WGSL, 'fsComposite', format),
      pointsGroup: device.createBindGroup({
        layout: points.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: { buffer: kg.depthBuffer } },
          { binding: 2, resource: { buffer: kg.lutBuffer } },
          { binding: 3, resource: { buffer: kg.irBuffer } },
        ],
      }),
    };
    targets = null;
  },

  frame(ctx) {
    const { device, context } = gpu;
    const p = ctx.params;
    const t = ensureTargets(ctx);
    const step = Number(p.step) || 2;
    const cols = Math.ceil(W / step);
    const rows = Math.ceil(H / step);
    const cam = ctx.camera;
    const fx = ctx.kinect.params?.fx ?? 365.5;
    uf.set(cam.viewProj, 0);
    uf.set([t.w, t.h, 1 / t.w, 1 / t.h], 16);
    uf.set([p.dotFill, step, fx, cam.focalPx], 20);
    uf.set([1 + p.fog, p.fog, ctx.xSign, p.irMix], 24);
    uu.set([cols, rows, step, 0], 28);
    device.queue.writeBuffer(res.uniformBuf, 0, uniforms);
    device.queue.writeBuffer(res.postBuf, 0, new Float32Array([...hex(p.dotColor), ...hex(p.bgCenter), ...hex(p.bgEdge), p.gain, p.glow, 0, 0]));

    const enc = device.createCommandEncoder();
    const pass = (view) => enc.beginRenderPass({ colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    let rp = pass(t.accView);
    if (ctx.kinect.depth) {
      rp.setPipeline(res.points);
      rp.setBindGroup(0, res.pointsGroup);
      rp.draw(6, cols * rows);
    }
    rp.end();
    if (p.glow > 0) {
      const full = (view, pipeline, group) => {
        const q = pass(view);
        q.setPipeline(pipeline);
        q.setBindGroup(0, group);
        q.draw(3);
        q.end();
      };
      full(t.q1View, res.down, t.down);
      full(t.q2View, res.blur, t.blurH);
      full(t.q1View, res.blur, t.blurV);
    }
    rp = pass(context.getCurrentTexture().createView());
    rp.setPipeline(res.composite);
    rp.setBindGroup(0, t.composite);
    rp.draw(3);
    rp.end();
    device.queue.submit([enc.finish()]);
    ctx.status = `${Math.round((cols * rows) / 1000)}k Punkte`;
  },

  dispose() {
    targets?.textures.forEach((t) => t.destroy());
    targets = null;
  },
};
