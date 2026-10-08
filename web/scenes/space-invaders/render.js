// The renderer (WebGPU): the map floor with its hex grid, lit by the game's lights; over it the crisp
// pixel layer of the game (at LED resolution: blocks placed to the LED, see pixels.js Pix); then bloom
// in two sizes, distortion ripples, color fringes and flashes.
//
// Made for an LED wall with 5.9 mm pitch: nothing finer than a few LEDs repeats regularly (no 1-LED
// lines, no raster, no dither), so neither the LED grid nor a camera sees moiré. The hex lines are soft
// and 2-3 LEDs wide at a period of ~36 LEDs; the fog edge and the glows are smooth.
//
// Passes: light map (one texel per art pixel: light is smooth) -> scene (W x H) -> bright parts
// down to 1/4 -> blur -> down to 1/8 -> blur -> final.

import { checkedModule } from '/lib/shader-pass.js';

export const MAX_LIGHTS = 128;

const WGSL = /* wgsl */ `
struct U {
  res: vec2f, art: vec2f, off: vec2f, S: f32, time: f32,
  scale: vec2f, shake: vec2f,
  flash: vec4f,
  hex: f32, pulse: f32, nLights: f32, nRipples: f32,
  chroma: f32, bloom: f32, bloomWide: f32, brightness: f32,
  ripples: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

// ---- the light map: every light summed up per art pixel
@group(1) @binding(0) var<storage, read> lights: array<vec4f>;
@fragment fn lightmap(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let art = pos.xy;
  var light = vec3f(0.0);
  let nl = u32(u.nLights);
  for (var i = 0u; i < nl; i++) {
    let a = lights[i * 2u];
    let c = lights[i * 2u + 1u];
    let d = (art - a.xy) / u.scale / max(a.z, 0.01);
    let d2 = dot(d, d);
    if (d2 < 1.0) {
      let f = (1.0 - d2);
      light += c.rgb * a.w * f * f;
    }
  }
  return vec4f(light, 1.0);
}

// ---- scene: floor + lights + the game's pixels
@group(1) @binding(1) var artTex: texture_2d<f32>;
@group(1) @binding(2) var fogTex: texture_2d<f32>;
@group(1) @binding(7) var lightTex: texture_2d<f32>;

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), w.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), w.x), w.y);
}
// pointy-top hexagons: distance (in hex units, across flats = 1) to the nearest edge
const HS = vec2f(1.0, 1.7320508);
fn hexEdge(p: vec2f) -> f32 {
  let hc = floor(vec4f(p, p - vec2f(0.5, 1.0)) / HS.xyxy) + 0.5;
  let h = vec4f(p - hc.xy * HS, p - (hc.zw + 0.5) * HS);
  let l = select(h.zw, h.xy, dot(h.xy, h.xy) < dot(h.zw, h.zw));
  let q = abs(l);
  return 0.5 - max(dot(q, HS * 0.5), q.x);
}

@fragment fn scene(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let art = (pos.xy - u.off - u.shake) / u.S;
  let auv = art / u.art;
  let fog = textureSampleLevel(fogTex, samp, auv, 0.0).r;
  // the floor: almost black, a faint large-scale texture (no fine pattern)
  let n = noise(art * 0.025) * 0.65 + noise(art * 0.06 + 17.0) * 0.35;
  let base = vec3f(0.006, 0.004, 0.02) * (0.5 + n) * mix(0.35, 1.0, fog);
  // hex lines: 12 art px across, soft and about 2-3 LEDs wide
  let hexSize = 12.0;
  let e = hexEdge(art / hexSize) * hexSize;
  let line = (1.0 - smoothstep(0.25, 0.9, e)) * fog;
  // the lights (from the light map, filtered: smooth between the art pixels)
  let light = textureSampleLevel(lightTex, samp, auv, 0.0).rgb;
  let gridCol = vec3f(0.3, 0.42, 1.0);
  var col = base + light * (0.07 + line * 1.5) + gridCol * line * u.hex * (0.03 + 0.05 * u.pulse);
  // the game's pixels (one texel per LED)
  let ai = vec2i(floor(pos.xy - u.shake));
  if (all(ai >= vec2i(0)) && all(ai < vec2i(u.res))) {
    let px = textureLoad(artTex, ai, 0);
    col = mix(col, px.rgb * (1.0 + light * 0.25), px.a);
  }
  return vec4f(col, 1.0);
}

// ---- bloom
@group(1) @binding(3) var src: texture_2d<f32>;
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
// 4 x 4 (2 x 2 linear taps) down, only what is bright
@fragment fn down4(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = pos.xy * 4.0 / size;
  let t = 1.0 / size;
  var c = vec3f(0.0);
  c += textureSampleLevel(src, samp, uv + vec2f(-1.0, -1.0) * t, 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(1.0, -1.0) * t, 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(-1.0, 1.0) * t, 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(1.0, 1.0) * t, 0.0).rgb;
  c *= 0.25;
  let k = smoothstep(0.3, 0.85, lum(c));
  return vec4f(c * k, 1.0);
}
@fragment fn down2(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = pos.xy * 2.0 / size;
  return vec4f(textureSampleLevel(src, samp, uv, 0.0).rgb, 1.0);
}
const W0 = 0.2270270270;
const W1 = 0.3162162162;
const W2 = 0.0702702703;
fn blur(pos: vec2f, dir: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = pos / size;
  let t = dir / size;
  var c = textureSampleLevel(src, samp, uv, 0.0).rgb * W0;
  c += textureSampleLevel(src, samp, uv + t * 1.3846153846, 0.0).rgb * W1;
  c += textureSampleLevel(src, samp, uv - t * 1.3846153846, 0.0).rgb * W1;
  c += textureSampleLevel(src, samp, uv + t * 3.2307692308, 0.0).rgb * W2;
  c += textureSampleLevel(src, samp, uv - t * 3.2307692308, 0.0).rgb * W2;
  return vec4f(c, 1.0);
}
@fragment fn blurH(@builtin(position) pos: vec4f) -> @location(0) vec4f { return blur(pos.xy, vec2f(1.0, 0.0)); }
@fragment fn blurV(@builtin(position) pos: vec4f) -> @location(0) vec4f { return blur(pos.xy, vec2f(0.0, 1.0)); }

// ---- final: ripples, color fringes, bloom, flash
@group(1) @binding(4) var sceneTex: texture_2d<f32>;
@group(1) @binding(5) var b4: texture_2d<f32>;
@group(1) @binding(6) var b8: texture_2d<f32>;
@fragment fn finish(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var off = vec2f(0.0);
  let nr = u32(u.nRipples);
  for (var i = 0u; i < nr; i++) {
    let r = u.ripples[i];
    let d = pos.xy - r.xy;
    let dist = max(length(d), 1e-3);
    let k = exp(-pow((dist - r.z) / 22.0, 2.0));
    off += d / dist * r.w * k;
  }
  let uv = (pos.xy - off) / u.res;
  let dir = (pos.xy / u.res - 0.5) * vec2f(1.0, u.res.y / u.res.x);
  let ca = dir * u.chroma * 10.0 / u.res;
  var col = vec3f(
    textureSampleLevel(sceneTex, samp, uv + ca, 0.0).r,
    textureSampleLevel(sceneTex, samp, uv, 0.0).g,
    textureSampleLevel(sceneTex, samp, uv - ca, 0.0).b);
  col += textureSampleLevel(b4, samp, uv, 0.0).rgb * u.bloom;
  col += textureSampleLevel(b8, samp, uv, 0.0).rgb * u.bloomWide;
  col += u.flash.rgb * u.flash.a;
  return vec4f(col * u.brightness, 1.0);
}
`;

export async function createRenderer(ctx) {
  const { device, context, format } = await ctx.webgpu();
  const module = await checkedModule(device, WGSL, 'space-invaders render');
  const F = GPUShaderStage.FRAGMENT;
  const common = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, sampler: { type: 'filtering' } },
    ],
  });
  const lightLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, buffer: { type: 'read-only-storage' } }] });
  const sceneLayout = device.createBindGroupLayout({
    entries: [
      { binding: 1, visibility: F, texture: { sampleType: 'float' } },
      { binding: 2, visibility: F, texture: { sampleType: 'float' } },
      { binding: 7, visibility: F, texture: { sampleType: 'float' } },
    ],
  });
  const srcLayout = device.createBindGroupLayout({ entries: [{ binding: 3, visibility: F, texture: { sampleType: 'float' } }] });
  const finalLayout = device.createBindGroupLayout({
    entries: [4, 5, 6].map((binding) => ({ binding, visibility: F, texture: { sampleType: 'float' } })),
  });
  const HDR = 'rgba16float';
  const pipe = (layout, entry, fmt) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [common, layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: entry, targets: [{ format: fmt }] },
    });
  device.pushErrorScope('validation');
  const P = {
    lightmap: pipe(lightLayout, 'lightmap', HDR),
    scene: pipe(sceneLayout, 'scene', HDR),
    down4: pipe(srcLayout, 'down4', HDR),
    down2: pipe(srcLayout, 'down2', HDR),
    blurH: pipe(srcLayout, 'blurH', HDR),
    blurV: pipe(srcLayout, 'blurV', HDR),
    final: pipe(finalLayout, 'finish', format),
  };
  const err = await device.popErrorScope();
  if (err) throw new Error(`Pipeline: ${err.message}`);

  const uniform = device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lightBuf = device.createBuffer({ size: MAX_LIGHTS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const commonGroup = device.createBindGroup({ layout: common, entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: sampler }] });
  const U = new Float32Array(56);

  let T = null; // size-dependent textures and bind groups
  function ensure(W, H, AW, AH) {
    if (T && T.W === W && T.H === H && T.AW === AW && T.AH === AH) return T;
    T?.list.forEach((t) => t.destroy());
    const RT = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const tex = (w, h, fmt = HDR, usage = RT) => device.createTexture({ size: [Math.max(1, w), Math.max(1, h)], format: fmt, usage });
    const scene = tex(W, H);
    const a4 = tex(Math.ceil(W / 4), Math.ceil(H / 4));
    const c4 = tex(Math.ceil(W / 4), Math.ceil(H / 4));
    const a8 = tex(Math.ceil(W / 8), Math.ceil(H / 8));
    const c8 = tex(Math.ceil(W / 8), Math.ceil(H / 8));
    const art = tex(W, H, 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const fog = tex(AW, AH, 'r8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const lm = tex(AW, AH);
    const src = (t) => device.createBindGroup({ layout: srcLayout, entries: [{ binding: 3, resource: t.createView() }] });
    T = {
      W,
      H,
      AW,
      AH,
      list: [scene, a4, c4, a8, c8, art, fog, lm],
      lm,
      lightGroup: device.createBindGroup({ layout: lightLayout, entries: [{ binding: 0, resource: { buffer: lightBuf } }] }),
      scene,
      a4,
      c4,
      a8,
      c8,
      art,
      fog,
      sceneGroup: device.createBindGroup({
        layout: sceneLayout,
        entries: [
          { binding: 1, resource: art.createView() },
          { binding: 2, resource: fog.createView() },
          { binding: 7, resource: lm.createView() },
        ],
      }),
      fromScene: src(scene),
      fromA4: src(a4),
      fromC4: src(c4),
      fromA8: src(a8),
      fromC8: src(c8),
      finalGroup: device.createBindGroup({
        layout: finalLayout,
        entries: [
          { binding: 4, resource: scene.createView() },
          { binding: 5, resource: a4.createView() },
          { binding: 6, resource: a8.createView() },
        ],
      }),
    };
    return T;
  }

  const pass = (enc, pipeline, group, view) => {
    const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    p.setPipeline(pipeline);
    p.setBindGroup(0, commonGroup);
    p.setBindGroup(1, group);
    p.draw(3);
    p.end();
  };

  const r = {
    /** the fog mask (AW x AH, 0..255: 255 where the Kinect sees people) */
    setFog(L, mask) {
      const t = ensure(L.W, L.H, L.AW, L.AH);
      device.queue.writeTexture({ texture: t.fog }, mask, { bytesPerRow: L.AW }, [L.AW, L.AH]);
    },
    /**
     * f: { L, art (Uint8ClampedArray W*H*4, LED resolution), lights (Float32Array), nLights, ripples [[x, y, r, amp] LED px],
     *      shake [x, y] LED px, flash [r, g, b, a], chroma, pulse, hex, bloom, bloomWide, brightness, time }
     */
    render(f) {
      const { L } = f;
      const t = ensure(L.W, L.H, L.AW, L.AH);
      device.queue.writeTexture({ texture: t.art }, f.art, { bytesPerRow: L.W * 4 }, [L.W, L.H]);
      if (f.nLights) device.queue.writeBuffer(lightBuf, 0, f.lights, 0, f.nLights * 8);
      U.fill(0);
      U.set([L.W, L.H, L.AW, L.AH, L.ox, L.oy, L.S, f.time, L.sx, L.sy, f.shake[0], f.shake[1]], 0);
      U.set(f.flash, 12);
      U.set([f.hex, f.pulse, f.nLights, f.ripples.length, f.chroma, f.bloom, f.bloomWide, f.brightness], 16);
      f.ripples.slice(0, 8).forEach((q, i) => U.set(q, 24 + i * 4));
      device.queue.writeBuffer(uniform, 0, U);
      const enc = device.createCommandEncoder();
      pass(enc, P.lightmap, t.lightGroup, t.lm.createView());
      pass(enc, P.scene, t.sceneGroup, t.scene.createView());
      pass(enc, P.down4, t.fromScene, t.a4.createView());
      pass(enc, P.blurH, t.fromA4, t.c4.createView());
      pass(enc, P.blurV, t.fromC4, t.a4.createView());
      pass(enc, P.down2, t.fromA4, t.a8.createView());
      pass(enc, P.blurH, t.fromA8, t.c8.createView());
      pass(enc, P.blurV, t.fromC8, t.a8.createView());
      pass(enc, P.final, t.finalGroup, context.getCurrentTexture().createView());
      device.queue.submit([enc.finish()]);
    },
    destroy() {
      T?.list.forEach((x) => x.destroy());
      T = null;
      uniform.destroy();
      lightBuf.destroy();
    },
  };
  return r;
}
