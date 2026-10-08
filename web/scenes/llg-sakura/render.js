// Drawing, as pixel art: everything is rendered into an "art" texture at the art resolution (one art
// pixel = P x P LEDs), then scaled up without smoothing onto the LED image and snapped to the
// palette (pixel.js), with ordered dithering where colors fall between palette entries (glows).
//
//   1. sprites behind the people: the painted backdrop, stars, lit windows, glows, blossom crowns,
//      lanterns, petals on the ground
//   2. the people: pixel figures with a dark outline, cel tones from the infrared image, a warm rim
//      light from above (the lanterns), each person in their own palette
//   3. sprites in front: petals in the air and on the people, the QR card's frame, the text layer
//
// Every sprite is an instance of one quad: x, y, half width, half height (art px), rotation, kind,
// two kind params, rgba, uv rect. Shapes have hard edges; glows add up and get dithered.

import { checkedModule } from '/lib/shader-pass.js';
import { createWallPersons } from '/lib/wall-persons.js';
import { C, PALETTE, rgb } from './pixel.js';
import { buildAtlas } from './sprites.js';

export const FLOATS = 16;
export const KIND = { atlas: 0, disc: 1, glow: 3, paint: 4, overlay: 5, streak: 6, rect: 7 };

const v3 = (hex) =>
  `vec3f(${rgb(hex)
    .map((v) => v.toFixed(4))
    .join(', ')})`;
// a palette per person slot: shadow, mid, light
const PEOPLE = [
  [C.sky4, C.sky8, C.sky10],
  [C.sky4, C.c1, C.c2],
  [C.sky4, C.p3, C.p5],
  [C.sky4, C.b0, C.b1],
  [C.sky4, C.sky9, C.sky11],
  [C.sky4, C.g4, C.g6],
];

// OKLab of the palette, for the nearest-color search
function oklab([r, g, b]) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

const WGSL = /* wgsl */ `
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
    default: { return vec4f(0.0); }
  }
}

// ---------- the people (art resolution)

@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

const PEOPLE_SHADOW = array<vec3f, ${PEOPLE.length}>(${PEOPLE.map((p) => v3(p[0])).join(', ')});
const PEOPLE_MID = array<vec3f, ${PEOPLE.length}>(${PEOPLE.map((p) => v3(p[1])).join(', ')});
const PEOPLE_LIGHT = array<vec3f, ${PEOPLE.length}>(${PEOPLE.map((p) => v3(p[2])).join(', ')});
const OUTLINE = ${v3(C.sky0)};
const RIM = ${v3(C.o5)};
const RIM2 = ${v3(C.y1)};
const SIL = ${v3(C.sky1)};

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
  let s = u32(slot + 0.5) % ${PEOPLE.length}u;
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

// ---------- art -> LED image: scale up, snap to the palette (dithered between entries)

const PAL = array<vec3f, ${PALETTE.length}>(${PALETTE.map(v3).join(', ')});
const PAL_LAB = array<vec3f, ${PALETTE.length}>(${PALETTE.map(
  (h) =>
    `vec3f(${oklab(rgb(h))
      .map((v) => v.toFixed(5))
      .join(', ')})`,
).join(', ')});
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
  for (var i = 0u; i < ${PALETTE.length}u; i++) {
    let d = lab - PAL_LAB[i];
    let dd = dot(d, d * vec3f(1.0, 1.4, 1.4));
    if (dd < bd) { bd = dd; best = f32(i); }
  }
  return vec2f(best, bd);
}

@fragment fn fsPost(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ap = vec2i(floor(pos.xy / u.post.x));
  let c = textureLoad(artTex, ap, 0).rgb;
  var n = nearest(c);
  if (n.y > 0.00002 && u.post.y > 0.0) {
    let b = (BAYER[(ap.y & 3) * 4 + (ap.x & 3)] + 0.5) / 16.0 - 0.5;
    n = nearest(saturate(c + vec3f(b * 0.11 * u.post.y)));
  }
  return vec4f(PAL[u32(n.x)], 1.0);
}
`;

export async function createRenderer(ctx) {
  const { device, context, format } = await ctx.webgpu();
  const module = await checkedModule(device, WGSL, `${ctx.scene}: render`);
  const persons = await createWallPersons(ctx);
  const F = GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, sampler: { type: 'filtering' } },
      ...[2, 3, 4, 5, 6].map((binding) => ({ binding, visibility: F, texture: { sampleType: 'float' } })),
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const ART = 'rgba8unorm';
  const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  const spritePipe = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [{ arrayStride: FLOATS * 4, stepMode: 'instance', attributes: [0, 1, 2, 3].map((i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })) }],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format: ART, blend }] },
  });
  const peoplePipe = device.createRenderPipeline({ layout: pipelineLayout, vertex: { module, entryPoint: 'vsFull' }, fragment: { module, entryPoint: 'fsPeople', targets: [{ format: ART, blend }] } });
  const postPipe = device.createRenderPipeline({ layout: pipelineLayout, vertex: { module, entryPoint: 'vsFull' }, fragment: { module, entryPoint: 'fsPost', targets: [{ format }] } });
  const uniBuf = ctx.track(device.createBuffer({ label: 'llg u', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const uni = new Float32Array(12);
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;

  const sheet = buildAtlas();
  const atlas = device.createTexture({ label: 'llg atlas', size: [sheet.canvas.width, sheet.canvas.height], format: 'rgba8unorm', usage });
  device.queue.copyExternalImageToTexture({ source: sheet.canvas }, { texture: atlas, premultipliedAlpha: true }, [sheet.canvas.width, sheet.canvas.height]);

  // art-sized layers: the painting, the text layer, the frame itself
  const layers = { paint: null, overlay: null, art: null, w: 0, h: 0 };
  let groups = null; // [while drawing the art (no art texture bound), for the palette pass]
  let groupPersonView = null;
  const dummy = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  function ensureLayers(aw, ah) {
    if (layers.art && layers.w === aw && layers.h === ah) return;
    for (const k of ['paint', 'overlay', 'art']) layers[k]?.destroy();
    for (const k of ['paint', 'overlay', 'art']) layers[k] = device.createTexture({ label: `llg ${k}`, size: [aw, ah], format: 'rgba8unorm', usage });
    layers.w = aw;
    layers.h = ah;
    groups = null;
  }
  function bindGroups() {
    if (groups && groupPersonView === persons.view) return groups;
    groupPersonView = persons.view;
    const make = (art) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniBuf } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: layers.paint.createView() },
          { binding: 3, resource: atlas.createView() },
          { binding: 4, resource: layers.overlay.createView() },
          { binding: 5, resource: persons.view },
          { binding: 6, resource: art.createView() },
        ],
      });
    groups = [make(dummy), make(layers.art)];
    return groups;
  }

  let instBuf = null;
  let instCap = 0;
  const upload = (texture, canvas) => device.queue.copyExternalImageToTexture({ source: canvas }, { texture, premultipliedAlpha: true }, [canvas.width, canvas.height]);

  return {
    sheet,
    uploadPaint(canvas) {
      ensureLayers(canvas.width, canvas.height);
      upload(layers.paint, canvas);
    },
    uploadOverlay(canvas) {
      ensureLayers(canvas.width, canvas.height);
      upload(layers.overlay, canvas);
    },
    /**
     * Draws a frame. data: instances; back: how many are behind the people; total: all.
     * p: { aw, ah, scale, style, rim, irGain, outline, dither }.
     */
    render(data, back, total, p) {
      ensureLayers(p.aw, p.ah);
      const enc = device.createCommandEncoder();
      persons.update(enc);
      if (!persons.view) {
        device.queue.submit([enc.finish()]);
        return;
      }
      if (total > instCap) {
        instCap = Math.max(1024, Math.ceil(total * 1.5));
        instBuf?.destroy();
        instBuf = device.createBuffer({ label: 'llg sprites', size: instCap * FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      device.queue.writeBuffer(instBuf, 0, data.buffer, data.byteOffset, total * FLOATS * 4);
      uni.set([p.aw, p.ah, ctx.time, p.style, 1, p.rim, p.irGain, p.outline, p.scale, p.dither, 0, 0]);
      device.queue.writeBuffer(uniBuf, 0, uni);
      const [gArt, gPost] = bindGroups();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: layers.art.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setBindGroup(0, gArt);
      pass.setPipeline(spritePipe);
      pass.setVertexBuffer(0, instBuf);
      if (back > 0) pass.draw(6, back, 0, 0);
      pass.setPipeline(peoplePipe);
      pass.draw(3);
      if (total > back) {
        pass.setPipeline(spritePipe);
        pass.draw(6, total - back, 0, back);
      }
      pass.end();
      const post = enc.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      post.setBindGroup(0, gPost);
      post.setPipeline(postPipe);
      post.draw(3);
      post.end();
      device.queue.submit([enc.finish()]);
    },
    dispose() {
      instBuf?.destroy();
      atlas.destroy();
      dummy.destroy();
      for (const k of ['paint', 'overlay', 'art']) layers[k]?.destroy();
    },
  };
}
