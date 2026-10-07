// shader-pass.js — a fullscreen fragment shader with the Kinect data bound, for 2D effects
// ("Shadertoy for the Kinect"). The scene only writes one WGSL function:
//
//   fn shade(pos: vec2f, uv: vec2f) -> vec4f      // pos in pixels, uv 0..1 (y down)
//
// and can use (see prelude() below):
//   F.resolution, F.time, F.dt, F.mouse, F.xSign, F.frame, F.depthAge, F.hasDepth
//   P.<param>        the scene's params with the same names (numbers/checkboxes f32, colors vec3f,
//                    options: the value if numeric, else the index)
//   kinectUv(uv)     screen uv -> depth image uv (image covers the screen, mirrored like 3D scenes)
//   depthAt(k)       depth in meters at depth image uv k, 0 = no measurement; depthSmooth(k) filtered
//   irAt(k)          infrared brightness 0..1
//   pointAt(k)       3D point in world space (m, x right, y up, z forward); z = 0 without measurement
//   inImage(k)       k inside the depth image?
//   prev(uv)         the previous output (only with feedback: true; for trails, echoes, ...)
// with streams: ['persons'] (person tracking, see persons.js; without it these stay 0):
//   personAt(k)      slot of the person at k (u32, 1..16), 0 = no person
//   isPerson(k)      personAt(k) > 0
//   personMask(k)    0..1 with smooth edges (bilinear), for soft silhouettes
//   personDepthAt(k) depth in meters if k belongs to a person, else 0 (same frame as the labels)
//   personPointAt(k) 3D point (world, m) of a person pixel; z = 0 elsewhere
//   personColor(s)   the default color of slot s (PERSON_COLORS in persons.js)
// the skeletons (also in mode 'skeleton', where the masks above stay empty):
//   personVisible(s)            slot s has a visible person; personInfo(s): visible, id, height m, age s
//   personJointUv(s, J_...)     xy: depth image uv like kinectUv(), z: depth m, w: confidence (0 = not seen)
//   personJoint(s, J_...)       xyz: world m like pointAt(), w: confidence
//   personBox(s)                the person's box in depth image uv (u0, v0, u1, v1)
//   personBoneDist(k, s)        distance (depth image pixels) from k to the stick figure of slot s
//   skeletonDist(k)             x: distance to the nearest stick figure of anyone, y: its slot (0 = none)
//   J_NOSE … J_RIGHT_ANKLE (0..16, COCO), J_NECK, J_PELVIS, J_HEAD, J_LEFT_HAND, J_RIGHT_HAND,
//   J_CENTER, J_GROUND; BONES / BONE_COUNT: the stick figure as pairs of J_ indices
//
//   const pass = await createShaderPass(ctx, { shade: SHADE_WGSL, feedback: true });
//   frame(ctx) { pass.render(); }

import { optionValues } from './params.js';
import { PERSON_COLORS, POINTS, BONES, MAX_PERSONS } from './persons.js';
import { PERSON_POINTS } from './kinect-data.js';

// WGSL names of the person points: leftHand -> J_LEFT_HAND
const jointConsts = POINTS.map((n, i) => `const J_${n.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} = ${i}u;`).join('\n');

/** Creates a shader module and throws a readable error (line numbers of `code`) if WGSL fails. */
export async function checkedModule(device, code, label = 'shader', lineOffset = 0) {
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const scopeError = await device.popErrorScope();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    const lines = code.split('\n');
    const text = errors
      .map((m) => {
        const n = m.lineNum - lineOffset;
        const where = n >= 1 ? `Zeile ${n}` : 'im Vorspann (Parametername?)';
        return `${where}: ${m.message}\n    ${(lines[m.lineNum - 1] ?? '').trim()}`;
      })
      .join('\n');
    throw new Error(`WGSL-Fehler in ${label}:\n${text}`);
  }
  if (scopeError) throw new Error(`WGSL-Fehler in ${label}: ${scopeError.message}`);
  return module;
}

/** Runs `create` and throws WebGPU validation errors right there instead of somewhere later. */
export async function validated(device, what, create) {
  device.pushErrorScope('validation');
  const result = create();
  const error = await device.popErrorScope();
  if (error) throw new Error(`${what}: ${error.message}`);
  return result;
}

const align = (n, a) => Math.ceil(n / a) * a;

function hexToRgb(hex) {
  const v = Number.parseInt(String(hex).slice(1), 16) || 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** WGSL struct for the scene's params, plus where each value goes in the uniform buffer. */
function paramLayout(specs) {
  const fields = [];
  const writers = [];
  let offset = 0;
  for (const p of specs) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(p.key)) continue;
    if (p.kind === 'color') {
      offset = align(offset, 16);
      fields.push(`${p.key}: vec3f`);
      writers.push({ ...p, at: offset / 4 });
      offset += 12;
    } else if (p.kind === 'number' || p.kind === 'boolean' || p.kind === 'select') {
      fields.push(`${p.key}: f32`);
      writers.push({ ...p, at: offset / 4 });
      offset += 4;
    }
  }
  if (!fields.length) {
    fields.push('_unused: f32');
    offset = 4;
  }
  return { struct: `struct Params {\n  ${fields.join(',\n  ')},\n};`, size: align(offset, 16), writers };
}

function prelude(layout, filterable) {
  return /* wgsl */ `struct Frame {
  resolution: vec2f, // canvas size in pixels
  time: f32,         // seconds since the scene started
  dt: f32,           // seconds since the previous frame
  mouse: vec4f,      // xy: pointer in pixels, z: 1 while a button is pressed
  xSign: f32,        // -1 = geometrically correct (default), 1 = mirror view (key m)
  frame: f32,        // frame counter
  depthAge: f32,     // seconds since the sensor captured the current depth frame
  hasDepth: f32,     // 1 once depth data arrived
};
${layout.struct}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> P: Params;
@group(0) @binding(2) var depthTex: texture_2d<f32>; // meters, 0 = no measurement
@group(0) @binding(3) var irTex: texture_2d<f32>;    // infrared 0..1
@group(0) @binding(4) var lutTex: texture_2d<f32>;   // rg: ray per pixel, point = (x*z, y*z, z)
@group(0) @binding(5) var prevTex: texture_2d<f32>;  // previous output (feedback: true)
@group(0) @binding(6) var smoothSampler: sampler;
@group(0) @binding(7) var personTex: texture_2d<u32>;      // slot of the person per pixel, 0 = none
@group(0) @binding(8) var personDepthTex: texture_2d<f32>; // meters, person pixels only
@group(0) @binding(9) var<storage, read> personPoints: array<vec4f>; // see personJoint()

const KINECT_SIZE = vec2f(512.0, 424.0);

fn kinectUv(uv: vec2f) -> vec2f {
  let screen = F.resolution.x / max(F.resolution.y, 1.0);
  let image = KINECT_SIZE.x / KINECT_SIZE.y;
  var k = uv - vec2f(0.5);
  if (screen > image) { k.y = k.y * image / screen; } else { k.x = k.x * screen / image; }
  k = k + vec2f(0.5);
  if (F.xSign < 0.0) { k.x = 1.0 - k.x; }
  return k;
}
fn inImage(k: vec2f) -> bool { return all(k >= vec2f(0.0)) && all(k <= vec2f(1.0)); }
fn kinectPx(k: vec2f) -> vec2i { return vec2i(clamp(k, vec2f(0.0), vec2f(0.99999)) * KINECT_SIZE); }
fn depthAt(k: vec2f) -> f32 { return textureLoad(depthTex, kinectPx(k), 0).r; }
fn depthSmooth(k: vec2f) -> f32 { ${filterable ? 'return textureSampleLevel(depthTex, smoothSampler, k, 0.0).r;' : 'return depthAt(k);'} }
fn irAt(k: vec2f) -> f32 { return textureSampleLevel(irTex, smoothSampler, k, 0.0).r; }
fn pointAt(k: vec2f) -> vec3f {
  let px = kinectPx(k);
  let z = textureLoad(depthTex, px, 0).r;
  let ray = textureLoad(lutTex, px, 0).rg;
  return vec3f(F.xSign * ray.x * z, -ray.y * z, z);
}
fn prev(uv: vec2f) -> vec4f { return textureSampleLevel(prevTex, smoothSampler, uv, 0.0); }
fn personAt(k: vec2f) -> u32 { return textureLoad(personTex, kinectPx(k), 0).r; }
fn isPerson(k: vec2f) -> bool { return personAt(k) > 0u; }
fn personMask(k: vec2f) -> f32 {
  let p = clamp(k, vec2f(0.0), vec2f(1.0)) * KINECT_SIZE - vec2f(0.5);
  let i = vec2i(floor(p));
  let f = fract(p);
  let hi = vec2i(511, 423);
  let a = f32(textureLoad(personTex, clamp(i, vec2i(0), hi), 0).r > 0u);
  let b = f32(textureLoad(personTex, clamp(i + vec2i(1, 0), vec2i(0), hi), 0).r > 0u);
  let c = f32(textureLoad(personTex, clamp(i + vec2i(0, 1), vec2i(0), hi), 0).r > 0u);
  let d = f32(textureLoad(personTex, clamp(i + vec2i(1, 1), vec2i(0), hi), 0).r > 0u);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn personDepthAt(k: vec2f) -> f32 { return textureLoad(personDepthTex, kinectPx(k), 0).r; }
fn personPointAt(k: vec2f) -> vec3f {
  let px = kinectPx(k);
  let z = textureLoad(personDepthTex, px, 0).r;
  let ray = textureLoad(lutTex, px, 0).rg;
  return vec3f(F.xSign * ray.x * z, -ray.y * z, z);
}
const PERSON_COLORS = array<vec3f, ${PERSON_COLORS.length}>(${PERSON_COLORS.map((h) => {
  const v = Number.parseInt(h.slice(1), 16);
  return `vec3f(${(((v >> 16) & 255) / 255).toFixed(4)}, ${(((v >> 8) & 255) / 255).toFixed(4)}, ${((v & 255) / 255).toFixed(4)})`;
}).join(', ')});
fn personColor(slot: u32) -> vec3f { return PERSON_COLORS[min(slot, ${PERSON_COLORS.length - 1}u)]; }
${jointConsts}
const PERSON_SLOTS = ${MAX_PERSONS}u;
const PERSON_POINTS = ${PERSON_POINTS}u;
const BONE_COUNT = ${BONES.length}u;
const BONES = array<vec2u, ${BONES.length}>(${BONES.map(([a, b]) => `vec2u(${a}u, ${b}u)`).join(', ')});
fn personEntry(slot: u32, j: u32) -> u32 { return (min(slot, PERSON_SLOTS) * PERSON_POINTS + min(j, PERSON_POINTS - 1u)) * 2u; }
fn personInfo(slot: u32) -> vec4f { return personPoints[personEntry(slot, PERSON_POINTS - 1u)]; }
fn personVisible(slot: u32) -> bool { return slot > 0u && personInfo(slot).x > 0.5; }
fn personBox(slot: u32) -> vec4f { return personPoints[personEntry(slot, PERSON_POINTS - 1u) + 1u]; }
fn personJointUv(slot: u32, j: u32) -> vec4f { return personPoints[personEntry(slot, j)]; }
fn personJoint(slot: u32, j: u32) -> vec4f { return personPoints[personEntry(slot, j) + 1u]; }
fn segmentDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - a - ab * t);
}
fn personBoneDist(k: vec2f, slot: u32) -> f32 {
  var d = 1e6;
  if (!personVisible(slot)) { return d; }
  let p = k * KINECT_SIZE;
  for (var b = 0u; b < BONE_COUNT; b++) {
    let a = personJointUv(slot, BONES[b].x);
    let c = personJointUv(slot, BONES[b].y);
    if (a.w > 0.0 && c.w > 0.0) { d = min(d, segmentDist(p, a.xy * KINECT_SIZE, c.xy * KINECT_SIZE)); }
  }
  return d;
}
fn skeletonDist(k: vec2f) -> vec2f {
  var best = vec2f(1e6, 0.0);
  for (var s = 1u; s <= PERSON_SLOTS; s++) {
    if (!personVisible(s)) { continue; }
    let box = personBox(s);
    let m = 40.0 / KINECT_SIZE; // a few cm around the box: hands and the glow just outside
    if (any(k < box.xy - m) || any(k > box.zw + m)) { continue; }
    let d = personBoneDist(k, s);
    if (d < best.x) { best = vec2f(d, f32(s)); }
  }
  return best;
}
`;
}

const FULLSCREEN = /* wgsl */ `
@vertex fn vs_fullscreen(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}`;

const MAIN = /* wgsl */ `${FULLSCREEN}
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return shade(pos.xy, pos.xy / F.resolution);
}`;

const BLIT = /* wgsl */ `${FULLSCREEN}
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn fs_blit(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(pos.xy), 0).rgb, 1.0);
}`;

export async function createShaderPass(ctx, { shade, feedback = false } = {}) {
  if (typeof shade !== 'string' || !shade.includes('fn shade')) {
    throw new Error('createShaderPass: { shade } muss WGSL mit fn shade(pos: vec2f, uv: vec2f) -> vec4f enthalten');
  }
  const { device, context, format } = await ctx.webgpu();
  const gpu = ctx.kinect.gpu;
  const layout = paramLayout(ctx.paramSpecs ?? []);
  const head = prelude(layout, gpu.filterable);
  const module = await checkedModule(device, `${head}\n${shade}\n${MAIN}`, `${ctx.scene}: shade()`, head.split('\n').length);

  const FRAG = GPUShaderStage.FRAGMENT;
  const sampleType = gpu.filterable ? 'float' : 'unfilterable-float';
  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: FRAG, buffer: { type: 'uniform' } },
      { binding: 1, visibility: FRAG, buffer: { type: 'uniform' } },
      { binding: 2, visibility: FRAG, texture: { sampleType } },
      { binding: 3, visibility: FRAG, texture: { sampleType: 'float' } },
      { binding: 4, visibility: FRAG, texture: { sampleType } },
      { binding: 5, visibility: FRAG, texture: { sampleType: 'float' } },
      { binding: 6, visibility: FRAG, sampler: { type: 'filtering' } },
      { binding: 7, visibility: FRAG, texture: { sampleType: 'uint' } },
      { binding: 8, visibility: FRAG, texture: { sampleType: 'unfilterable-float' } },
      { binding: 9, visibility: FRAG, buffer: { type: 'read-only-storage' } },
    ],
  });
  const targetFormat = feedback ? 'rgba16float' : format;
  const pipeline = await validated(device, 'Pipeline', () =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: targetFormat }] },
    }),
  );
  let blit = null;
  if (feedback) {
    const blitModule = await checkedModule(device, BLIT, 'blit');
    blit = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blitModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: blitModule, entryPoint: 'fs_blit', targets: [{ format }] },
    });
  }

  const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
  const frameBuf = device.createBuffer({ label: 'shade F', size: 48, usage: UNIFORM });
  const paramBuf = device.createBuffer({ label: 'shade P', size: layout.size, usage: UNIFORM });
  const frameData = new Float32Array(12);
  const paramData = new Float32Array(layout.size / 4);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const black = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const kinectViews = [
    gpu.depthTexture.createView(),
    gpu.irTexture.createView(),
    gpu.lutTexture.createView(),
    gpu.personLabelTexture.createView(),
    gpu.personDepthTexture.createView(),
  ];
  const group = (prevView) =>
    device.createBindGroup({
      layout: bindLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuf } },
        { binding: 1, resource: { buffer: paramBuf } },
        { binding: 2, resource: kinectViews[0] },
        { binding: 3, resource: kinectViews[1] },
        { binding: 4, resource: kinectViews[2] },
        { binding: 5, resource: prevView },
        { binding: 6, resource: sampler },
        { binding: 7, resource: kinectViews[3] },
        { binding: 8, resource: kinectViews[4] },
        { binding: 9, resource: { buffer: gpu.personPointBuffer } },
      ],
    });
  const plainGroup = group(black.createView());

  // feedback: render into one of two textures, read the other one as prev()
  let targets = null;
  function ensureTargets() {
    if (targets && targets.w === ctx.width && targets.h === ctx.height) return targets;
    targets?.textures.forEach((t) => t.destroy());
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const textures = [0, 1].map(() => device.createTexture({ size: [ctx.width, ctx.height], format: 'rgba16float', usage }));
    targets = {
      w: ctx.width,
      h: ctx.height,
      textures,
      current: 0,
      groups: [group(textures[1].createView()), group(textures[0].createView())], // groups[i] reads the other one
      blits: textures.map((t) => device.createBindGroup({ layout: blit.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView() }] })),
    };
    return targets;
  }

  function writeUniforms() {
    const k = ctx.kinect;
    const age = k.depth ? Math.min(60, k.ageMs(k.depth) / 1000) : 60;
    frameData.set([ctx.width, ctx.height, ctx.time, ctx.dt, ctx.pointer.x, ctx.pointer.y, ctx.pointer.down ? 1 : 0, 0, ctx.xSign, ctx.frame, age, k.depth ? 1 : 0]);
    device.queue.writeBuffer(frameBuf, 0, frameData);
    for (const w of layout.writers) {
      const v = ctx.params[w.key];
      if (w.kind === 'color') paramData.set(hexToRgb(v), w.at);
      else if (w.kind === 'boolean') paramData[w.at] = v ? 1 : 0;
      else if (w.kind === 'select') paramData[w.at] = typeof v === 'number' ? v : Math.max(0, optionValues(w.options).indexOf(v));
      else paramData[w.at] = Number(v) || 0;
    }
    device.queue.writeBuffer(paramBuf, 0, paramData);
  }

  const draw = (enc, view, pipe, bindGroup) => {
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  };

  const pass = {
    pipeline,
    module,
    /** Draws one frame (call it from frame(ctx)). */
    render() {
      writeUniforms();
      const enc = device.createCommandEncoder();
      if (feedback) {
        const t = ensureTargets();
        draw(enc, t.textures[t.current].createView(), pipeline, t.groups[t.current]);
        draw(enc, context.getCurrentTexture().createView(), blit, t.blits[t.current]);
        t.current = 1 - t.current;
      } else {
        draw(enc, context.getCurrentTexture().createView(), pipeline, plainGroup);
      }
      device.queue.submit([enc.finish()]);
    },
    dispose() {
      targets?.textures.forEach((t) => t.destroy());
      targets = null;
      black.destroy();
      frameBuf.destroy();
      paramBuf.destroy();
    },
  };
  ctx.onDispose(() => pass.dispose());
  return pass;
}
