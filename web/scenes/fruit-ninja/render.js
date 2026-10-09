// The renderer (WebGPU, from space-invaders): the scenery (scenery.js, a still picture at LED
// resolution), lit by the game's lights; over it the crisp pixel layer of the game (at LED resolution:
// blocks placed to the LED, see pix.js); then bloom in two sizes, distortion ripples, color fringes and
// flashes.
//
// Made for an LED wall with 5.9 mm pitch: nothing finer than a few LEDs repeats regularly (no 1-LED
// lines, no raster, no dither), so neither the LED grid nor a camera sees moiré. The scenery is drawn
// in blocks of 2 x 2 LEDs; the glows are smooth.
//
// Passes: light map (one texel per art pixel: light is smooth) -> scene (W x H) -> the blade strokes
// added on top (strokes.js: soft ribbons) -> bright parts down to 1/4 -> blur -> down to 1/8 -> blur
// -> final.

import { checkedModule } from '/lib/shader-pass.js';
import { MAX_TRAIL_VERTS } from './strokes.js';

export const MAX_LIGHTS = 128;

const WGSL = /* wgsl */ `
struct U {
  res: vec2f, art: vec2f, sceneryBloom: f32, pad: f32, S: f32, time: f32,
  scale: vec2f, shake: vec2f,
  flash: vec4f,
  scenery: f32, sceneryLight: f32, nLights: f32, nRipples: f32,
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

// ---- scene: the scenery + lights + the game's pixels
@group(1) @binding(1) var artTex: texture_2d<f32>;
@group(1) @binding(2) var bgTex: texture_2d<f32>;
@group(1) @binding(7) var lightTex: texture_2d<f32>;

@fragment fn scene(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let art = (pos.xy - u.shake) / u.S;
  let auv = art / u.art;
  // the lights (from the light map, filtered: smooth between the art pixels)
  let light = textureSampleLevel(lightTex, samp, auv, 0.0).rgb;
  // the scenery (one texel per LED), lit by the game: juice and blades light up the night around them
  let ai = vec2i(floor(pos.xy - u.shake));
  let inside = all(ai >= vec2i(0)) && all(ai < vec2i(u.res));
  var col = light * 0.03;
  var glow = 1.0; // how much of this pixel blooms (alpha): the scenery only a little, the game fully
  if (inside) {
    let bg = textureLoad(bgTex, ai, 0).rgb * u.scenery;
    col += bg * (1.0 + light * u.sceneryLight);
    // the game's pixels
    let px = textureLoad(artTex, ai, 0);
    col = mix(col, px.rgb * (1.0 + light * 0.25), px.a);
    glow = mix(u.sceneryBloom, 1.0, px.a);
  }
  return vec4f(col, glow);
}

// ---- the blade strokes: ribbons with a soft profile across, added onto the picture
struct TV { a: vec4f, b: vec4f, c: vec4f };
@group(1) @binding(0) var<storage, read> tv: array<TV>;
struct TO {
  @builtin(position) pos: vec4f,
  @location(0) across: f32,
  @location(1) along: f32,
  @location(2) col: vec4f,
  @location(3) @interpolate(flat) kind: vec2f,
};
@vertex fn trailVs(@builtin(vertex_index) i: u32) -> TO {
  let v = tv[i];
  let p = v.a.xy + u.shake;
  var o: TO;
  o.pos = vec4f(p.x / u.res.x * 2.0 - 1.0, 1.0 - p.y / u.res.y * 2.0, 0.0, 1.0);
  o.across = v.a.z;
  o.along = v.a.w;
  o.col = v.b;
  o.kind = v.c.xy;
  return o;
}
@fragment fn trailFs(in: TO) -> @location(0) vec4f {
  let s = abs(in.across);
  let fw = max(fwidth(in.across), 1e-3);
  var c = vec3f(0.0);
  if (in.kind.y > 0.5) {
    // the woosh: a soft band, speed lines in it broken into dashes along the way
    let band = pow(max(1.0 - s * s, 0.0), 1.5);
    var lines = 0.0;
    for (var j = 0; j < 3; j++) {
      let off = -0.55 + f32(j) * 0.55;
      let lw = max(2.0 * fw, 0.1);
      let dash = smoothstep(0.25, 0.4, fract(in.along * 2.3 + f32(j) * 0.37));
      lines += (1.0 - smoothstep(lw * 0.5, lw, abs(in.across - off))) * dash;
    }
    c = in.col.rgb * (band * 0.85 + lines * 0.35 * (1.0 - s));
  } else {
    // a blade or a slash: a crisp white core in a glow of its color
    let glow = (1.0 - s) * (1.0 - s);
    let core = 1.0 - smoothstep(in.kind.x - fw, in.kind.x + fw, s);
    c = in.col.rgb * glow * 0.9 + vec3f(1.0) * core;
  }
  return vec4f(c * in.col.a, in.col.a);
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
  var g = 0.0;
  for (var i = 0; i < 4; i++) {
    let o = vec2f(select(-1.0, 1.0, (i & 1) == 1), select(-1.0, 1.0, i >= 2));
    let s = textureSampleLevel(src, samp, uv + o * t, 0.0);
    c += s.rgb * 0.25;
    g += s.a * 0.25;
  }
  let k = smoothstep(0.3, 0.85, lum(c)) * g;
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
  const module = await checkedModule(device, WGSL, 'fruit-ninja render');
  const F = GPUShaderStage.FRAGMENT;
  const common = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: F | GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
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
  const trailLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }] });
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
    trail: device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [common, trailLayout] }),
      vertex: { module, entryPoint: 'trailVs' },
      fragment: {
        module,
        entryPoint: 'trailFs',
        targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }],
      },
    }),
  };
  const err = await device.popErrorScope();
  if (err) throw new Error(`Pipeline: ${err.message}`);

  const uniform = device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lightBuf = device.createBuffer({ size: MAX_LIGHTS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const trailBuf = device.createBuffer({ size: MAX_TRAIL_VERTS * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const trailGroup = device.createBindGroup({ layout: trailLayout, entries: [{ binding: 0, resource: { buffer: trailBuf } }] });
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
    const bg = tex(W, H, 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const lm = tex(AW, AH);
    const src = (t) => device.createBindGroup({ layout: srcLayout, entries: [{ binding: 3, resource: t.createView() }] });
    T = {
      W,
      H,
      AW,
      AH,
      list: [scene, a4, c4, a8, c8, art, bg, lm],
      lm,
      lightGroup: device.createBindGroup({ layout: lightLayout, entries: [{ binding: 0, resource: { buffer: lightBuf } }] }),
      scene,
      a4,
      c4,
      a8,
      c8,
      art,
      bg,
      sceneGroup: device.createBindGroup({
        layout: sceneLayout,
        entries: [
          { binding: 1, resource: art.createView() },
          { binding: 2, resource: bg.createView() },
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
    /** the still scenery (Uint8ClampedArray W*H*4, LED resolution); again after a resize */
    setScenery(L, buf) {
      const t = ensure(L.W, L.H, L.AW, L.AH);
      device.queue.writeTexture({ texture: t.bg }, buf, { bytesPerRow: L.W * 4 }, [L.W, L.H]);
      t.hasBg = true;
    },
    /** true when the textures were made anew (a new size): the scenery must be set again */
    needsScenery(L) {
      return !ensure(L.W, L.H, L.AW, L.AH).hasBg;
    },
    /**
     * f: { L, art (Uint8ClampedArray W*H*4, LED resolution), lights (Float32Array), nLights, ripples [[x, y, r, amp] LED px],
     *      shake [x, y] LED px, flash [r, g, b, a], chroma, scenery (brightness), sceneryLight, bloom, bloomWide, brightness, time }
     */
    render(f) {
      const { L } = f;
      const t = ensure(L.W, L.H, L.AW, L.AH);
      device.queue.writeTexture({ texture: t.art }, f.art, { bytesPerRow: L.W * 4 }, [L.W, L.H]);
      if (f.nLights) device.queue.writeBuffer(lightBuf, 0, f.lights, 0, f.nLights * 8);
      if (f.nTrail) device.queue.writeBuffer(trailBuf, 0, f.trail, 0, f.nTrail * 12);
      U.fill(0);
      U.set([L.W, L.H, L.AW, L.AH, f.sceneryBloom ?? 0.3, 0, L.S, f.time, L.ppm, L.ppm, f.shake[0], f.shake[1]], 0);
      U.set(f.flash, 12);
      U.set([f.scenery, f.sceneryLight, f.nLights, f.ripples.length, f.chroma, f.bloom, f.bloomWide, f.brightness], 16);
      f.ripples.slice(0, 8).forEach((q, i) => U.set(q, 24 + i * 4));
      device.queue.writeBuffer(uniform, 0, U);
      const enc = device.createCommandEncoder();
      pass(enc, P.lightmap, t.lightGroup, t.lm.createView());
      pass(enc, P.scene, t.sceneGroup, t.scene.createView());
      if (f.nTrail) {
        const tp = enc.beginRenderPass({ colorAttachments: [{ view: t.scene.createView(), loadOp: 'load', storeOp: 'store' }] });
        tp.setPipeline(P.trail);
        tp.setBindGroup(0, commonGroup);
        tp.setBindGroup(1, trailGroup);
        tp.draw(f.nTrail);
        tp.end();
      }
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
      trailBuf.destroy();
    },
  };
  return r;
}
