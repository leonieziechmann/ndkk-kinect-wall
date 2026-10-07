// Kinect point cloud in WebGPU: white, lit dots on dark gray with glow, seen from an orbiting
// virtual camera. Depth arrives from kinect-hub as u16 mm; the undistortion table (LUT) is
// computed once by the hub, the GPU only does point = (x*z, y*z, z) per pixel.

import { KinectStream } from '../lib/kinect-stream.js';

const W = 512;
const H = 424;
const HFOV = (70 * Math.PI) / 180;
const MAX_CANVAS_WIDTH = 2560;

const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const stateEl = document.getElementById('state');

const settings = { dotFill: 0.42, step: 2, glow: true, irMix: 0, mirror: true, showHelp: true };
const view = { yaw: 0, pitch: 14, zoom: 1.6, auto: true, t0: performance.now(), drag: null };

function fatal(msg) {
  const el = document.getElementById('fatal');
  el.textContent = msg;
  el.style.display = 'grid';
}

// ---------- shaders ----------

const POINTS_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  viewport: vec4f, // width, height, 1/width, 1/height
  p0: vec4f,       // dotFill, step, fx of the depth camera, focal length of the view in px
  p1: vec4f,       // fog a, fog b, mirror (-1/1), ir mix
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
struct Post { gain: f32, glowGain: f32, bgCenter: f32, bgEdge: f32 };
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
  let bg = mix(P.bgCenter, P.bgEdge, min(1.0, 2.0 * dot(f, f))); // gray with a soft vignette
  let dots = 1.0 - exp(-P.gain * a);
  let halo = 1.0 - exp(-P.gain * g);
  let v = bg + (1.0 - bg) * dots + P.glowGain * halo * (1.0 - dots) + (hash(fc.xy) - 0.5) / 255.0;
  return vec4f(vec3f(clamp(v, 0.0, 1.0)), 1.0);
}
`;

// ---------- small math ----------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Orbit camera around (0, 0, pivotZ); at yaw = pitch = 0 and zoom = 1 it sits on the sensor. */
function viewProjection(yawDeg, pitchDeg, pivotZ, zoom, aspect) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const dist = pivotZ * zoom;
  const pos = [dist * back[0], dist * back[1], pivotZ + dist * back[2]];
  const f = [-back[0], -back[1], -back[2]];
  const r = normalize(cross([0, 1, 0], f));
  const u = cross(f, r);
  const sx = 1 / Math.tan(HFOV / 2);
  const sy = sx * aspect;
  const near = 0.05;
  const far = 100;
  const A = far / (far - near);
  const B = (-near * far) / (far - near);
  const V = [
    [r[0], r[1], r[2], -dot(r, pos)],
    [u[0], u[1], u[2], -dot(u, pos)],
    [f[0], f[1], f[2], -dot(f, pos)],
    [0, 0, 0, 1],
  ];
  const P = [
    [sx, 0, 0, 0],
    [0, sy, 0, 0],
    [0, 0, A, B],
    [0, 0, 1, 0],
  ];
  const out = new Float32Array(16); // column-major for WGSL
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += P[i][k] * V[k][j];
      out[j * 4 + i] = s;
    }
  return { matrix: out, sx };
}

function viewAngles(now) {
  if (!view.auto) return [view.yaw, view.pitch];
  return [view.yaw + 32 * Math.sin((2 * Math.PI * (now - view.t0)) / 28000), view.pitch];
}

function freezeOrbit(now) {
  if (view.auto) {
    [view.yaw, view.pitch] = viewAngles(now);
    view.auto = false;
  }
}

// ---------- main ----------

async function main() {
  if (!navigator.gpu) {
    fatal('Dieser Browser unterstützt kein WebGPU. Bitte ein aktuelles Chrome oder Edge verwenden.');
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    fatal('Kein WebGPU-Adapter verfügbar (Grafiktreiber?).');
    return;
  }
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    console.warn('GPU device lost:', info.message);
    if (info.reason !== 'destroyed') setTimeout(() => location.reload(), 1000);
  });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', e.error.message));

  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const depthBuf = device.createBuffer({ size: W * H * 2, usage: STORAGE });
  const irBuf = device.createBuffer({ size: W * H, usage: STORAGE });
  const rayBuf = device.createBuffer({ size: W * H * 8, usage: STORAGE });
  const uniformBuf = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const postBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const blurBufs = [
    [1.6, 0],
    [0, 1.6],
  ].map((d) => {
    const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, new Float32Array([d[0], d[1], 0, 0]));
    return b;
  });

  // pinhole rays until the hub sends the real undistortion table
  let fxIr = 365.5;
  {
    const rays = new Float32Array(W * H * 2);
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        rays[(v * W + u) * 2] = (u - 256) / fxIr;
        rays[(v * W + u) * 2 + 1] = (v - 206) / fxIr;
      }
    device.queue.writeBuffer(rayBuf, 0, rays);
  }

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const additive = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
  const pointsModule = device.createShaderModule({ code: POINTS_WGSL });
  const pointsPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: pointsModule, entryPoint: 'vs' },
    fragment: { module: pointsModule, entryPoint: 'fs', targets: [{ format: 'r16float', blend: additive }] },
    primitive: { topology: 'triangle-list' },
  });
  const fullscreen = (code, entryPoint, targetFormat) => {
    const module = device.createShaderModule({ code });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsFull' },
      fragment: { module, entryPoint, targets: [{ format: targetFormat }] },
      primitive: { topology: 'triangle-list' },
    });
  };
  const downPipeline = fullscreen(DOWN_WGSL, 'fsDown', 'r16float');
  const blurPipeline = fullscreen(BLUR_WGSL, 'fsBlur', 'r16float');
  const compositePipeline = fullscreen(COMPOSITE_WGSL, 'fsComposite', format);

  const pointsBindGroup = device.createBindGroup({
    layout: pointsPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: depthBuf } },
      { binding: 2, resource: { buffer: rayBuf } },
      { binding: 3, resource: { buffer: irBuf } },
    ],
  });

  // size-dependent textures and bind groups
  let targets = null;
  function ensureTargets() {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.round(canvas.clientWidth * dpr);
    let h = Math.round(canvas.clientHeight * dpr);
    if (w > MAX_CANVAS_WIDTH) {
      h = Math.round((h * MAX_CANVAS_WIDTH) / w);
      w = MAX_CANVAS_WIDTH;
    }
    w = Math.max(16, w);
    h = Math.max(16, h);
    if (targets && targets.w === w && targets.h === h) return targets;
    targets?.textures.forEach((t) => t.destroy());
    canvas.width = w;
    canvas.height = h;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const acc = device.createTexture({ size: [w, h], format: 'r16float', usage });
    const qw = Math.max(1, Math.ceil(w / 4));
    const qh = Math.max(1, Math.ceil(h / 4));
    const q1 = device.createTexture({ size: [qw, qh], format: 'r16float', usage });
    const q2 = device.createTexture({ size: [qw, qh], format: 'r16float', usage });
    const bg = (pipeline, entries) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    targets = {
      w,
      h,
      textures: [acc, q1, q2],
      accView: acc.createView(),
      q1View: q1.createView(),
      q2View: q2.createView(),
      down: bg(downPipeline, [{ binding: 0, resource: acc.createView() }, { binding: 1, resource: sampler }]),
      blurH: bg(blurPipeline, [
        { binding: 0, resource: q1.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: blurBufs[0] } },
      ]),
      blurV: bg(blurPipeline, [
        { binding: 0, resource: q2.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: blurBufs[1] } },
      ]),
      composite: bg(compositePipeline, [
        { binding: 0, resource: acc.createView() },
        { binding: 1, resource: q1.createView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: postBuf } },
      ]),
    };
    return targets;
  }

  // ---------- data from the hub ----------

  const streams = () => ['depth', 'lut', 'meta', 'status', ...(settings.irMix > 0 ? ['ir'] : [])];
  const kinect = new KinectStream({ streams: streams() });
  let haveDepth = false;
  let lastDepth = null;
  let pivotZ = 2.5;
  const sensorFps = { n: 0, t: performance.now(), value: 0 };
  kinect.addEventListener('depth', (e) => {
    const f = e.detail;
    device.queue.writeBuffer(depthBuf, 0, f.data); // upload at once; the next animation frame shows it
    haveDepth = true;
    lastDepth = f;
    sensorFps.n++;
  });
  kinect.addEventListener('ir', (e) => device.queue.writeBuffer(irBuf, 0, e.detail.data));
  kinect.addEventListener('lut', (e) => device.queue.writeBuffer(rayBuf, 0, e.detail.data));
  kinect.addEventListener('params', (e) => {
    if (e.detail.params?.fx) fxIr = e.detail.params.fx;
  });
  kinect.addEventListener('frame', (e) => {
    const median = e.detail.stats?.median_mm;
    if (median > 300) pivotZ = 0.92 * pivotZ + 0.08 * (median / 1000);
  });
  kinect.connect();

  // ---------- input ----------

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    freezeOrbit(performance.now());
    view.drag = { x: e.clientX, y: e.clientY };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!view.drag) return;
    view.yaw -= (e.clientX - view.drag.x) * 0.3;
    view.pitch = clamp(view.pitch + (e.clientY - view.drag.y) * 0.3, -20, 75);
    view.drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => {
    view.drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      view.zoom = clamp(view.zoom * (e.deltaY > 0 ? 1 / 0.9 : 0.9), 0.25, 4);
    },
    { passive: false },
  );
  let helpShownAt = performance.now();
  let screenshotRequested = false;
  window.addEventListener('keydown', (e) => {
    const now = performance.now();
    switch (e.key) {
      case ' ':
        if (view.auto) freezeOrbit(now);
        else {
          view.auto = true;
          view.t0 = now;
        }
        e.preventDefault();
        break;
      case 'r':
        Object.assign(view, { yaw: 0, pitch: 14, zoom: 1.6, auto: true, t0: now });
        break;
      case '+':
      case '=':
        settings.dotFill = Math.min(1.2, settings.dotFill * 1.15);
        break;
      case '-':
      case '_':
        settings.dotFill = Math.max(0.1, settings.dotFill / 1.15);
        break;
      case 'd':
        settings.step = (settings.step % 3) + 1;
        break;
      case 'g':
        settings.glow = !settings.glow;
        break;
      case 'i':
        settings.irMix = settings.irMix > 0 ? 0 : 0.8;
        kinect.subscribe(streams());
        break;
      case 'm':
        settings.mirror = !settings.mirror;
        break;
      case 'h':
        settings.showHelp = !settings.showHelp;
        helpShownAt = now;
        break;
      case 'f':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
        break;
      case 's':
        screenshotRequested = true;
        break;
    }
  });

  // ---------- render loop ----------

  const uniforms = new ArrayBuffer(128);
  const uf = new Float32Array(uniforms);
  const uu = new Uint32Array(uniforms);
  const renderFps = { n: 0, t: performance.now(), value: 0 };
  let latencyMs = 0;
  let lastShownSeq = -1;
  let lastHud = 0;

  function render(now) {
    requestAnimationFrame(render);
    const t = ensureTargets();
    const step = settings.step;
    const cols = Math.ceil(W / step);
    const rows = Math.ceil(H / step);
    const [yaw, pitch] = viewAngles(now);
    const { matrix, sx } = viewProjection(yaw, pitch, pivotZ, view.zoom, t.w / t.h);
    uf.set(matrix, 0);
    uf.set([t.w, t.h, 1 / t.w, 1 / t.h], 16);
    uf.set([settings.dotFill, step, fxIr, (sx * t.w) / 2], 20);
    uf.set([1.2, 0.2, settings.mirror ? -1 : 1, settings.irMix], 24);
    uu.set([cols, rows, step, 0], 28);
    device.queue.writeBuffer(uniformBuf, 0, uniforms);
    device.queue.writeBuffer(postBuf, 0, new Float32Array([1.5, settings.glow ? 0.35 : 0, 0.175, 0.115]));

    const enc = device.createCommandEncoder();
    const pass = (viewTex, clear = true) =>
      enc.beginRenderPass({
        colorAttachments: [{ view: viewTex, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: clear ? 'clear' : 'load', storeOp: 'store' }],
      });
    let p = pass(t.accView);
    if (haveDepth) {
      p.setPipeline(pointsPipeline);
      p.setBindGroup(0, pointsBindGroup);
      p.draw(6, cols * rows);
    }
    p.end();
    if (settings.glow) {
      const full = (target, pipeline, group) => {
        const q = pass(target);
        q.setPipeline(pipeline);
        q.setBindGroup(0, group);
        q.draw(3);
        q.end();
      };
      full(t.q1View, downPipeline, t.down);
      full(t.q2View, blurPipeline, t.blurH);
      full(t.q1View, blurPipeline, t.blurV);
    }
    p = pass(context.getCurrentTexture().createView());
    p.setPipeline(compositePipeline);
    p.setBindGroup(0, t.composite);
    p.draw(3);
    p.end();
    device.queue.submit([enc.finish()]);

    if (lastDepth && lastDepth.seq !== lastShownSeq) {
      lastShownSeq = lastDepth.seq;
      const l = kinect.ageMs(lastDepth);
      latencyMs = latencyMs ? 0.9 * latencyMs + 0.1 * l : l;
    }
    if (screenshotRequested) {
      screenshotRequested = false;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `kinect-punktwolke-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      });
    }

    renderFps.n++;
    for (const c of [renderFps, sensorFps]) {
      if (now - c.t >= 1000) {
        c.value = (c.n * 1000) / (now - c.t);
        c.n = 0;
        c.t = now;
      }
    }
    if (now - lastHud > 250) {
      lastHud = now;
      updateHud(now, cols * rows);
    }
  }

  function updateHud(now, points) {
    const sensor = kinect.status?.sensor;
    let state = '';
    if (!kinect.connected) state = 'Keine Verbindung zu kinect-hub – verbinde neu …';
    else if (sensor && sensor.state !== 'streaming')
      state = `Kinect: ${sensor.state}${sensor.detail ? ` (${sensor.detail})` : ''}`;
    else if (lastDepth && kinect.ageMs(lastDepth) > 1000) state = `keine neuen Bilder seit ${(kinect.ageMs(lastDepth) / 1000).toFixed(1)} s`;
    stateEl.textContent = state;
    stateEl.style.display = state ? 'block' : 'none';

    const visible = settings.showHelp && now - helpShownAt < 9000;
    hud.classList.toggle('hidden', !visible);
    if (!visible) return;
    hud.textContent = [
      `${Math.round(points / 1000)}k Punkte · ${renderFps.value.toFixed(0)} fps Anzeige · ${sensorFps.value.toFixed(1)} fps Sensor`,
      `Latenz Sensor → Browser ${latencyMs.toFixed(1)} ms`,
      '',
      'Maus ziehen = drehen · Rad = Zoom · Leertaste = Auto-Orbit · r = Reset',
      '+/- Punktgröße · d Dichte · g Glow · i IR-Helligkeit · m Spiegeln',
      'f Vollbild · s Screenshot · h Hilfe',
    ].join('\n');
  }

  requestAnimationFrame(render);
}

main().catch((err) => {
  console.error(err);
  fatal(`Fehler beim Start: ${err.message ?? err}`);
});
