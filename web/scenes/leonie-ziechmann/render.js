// The compositor, one fullscreen pass on the LED image:
//
//   1. the wood in layers (forest.js), far to near, with the signs, the signpost and the leaf heap
//      as one more layer at their depth (cards.js layer 1, the heap in leaves.js with alpha 253);
//      the people go in between: every person pixel lands behind the layers nearer to the sensor
//      than the person and in front of the farther ones, so walkers pass in front of one birch
//      and behind the next, in front of the signs or behind them
//   2. the people as soft, dark shadows (walkers in mist): they cover what lies behind them with a
//      deep indigo, strongly nearer, faintly far back in the wood, soft-edged; the mist and light of
//      the nearer layers lies over them; over a sign a shadow stays thin, so the code can still be
//      read (the people in perspective: persp.js; r = covered, g = distance from the sensor)
//   3. the leaves in the air (alpha 254)
//   4. the contact card (cards.js layer 0) and the leaves lying on it (alpha 255)
//   5. overall brightness

import { checkedModule } from '/lib/shader-pass.js';
import { createPerspPersons } from './persp.js';

const LAYERS = 4;

const WGSL = /* wgsl */ `
struct U {
  res: vec2f,
  time: f32,
  s: f32,           // LED px per design px
  bright: f32,
  near: f32,        // shadow strength near the sensor
  far: f32,         // ... and far away
  soft: f32,        // edge softness (design px)
  tint: vec4f,      // the shadow's color, ground y (px)
  depth: vec4f,     // distance of tree layers 1..3 from the sensor (m), of the signs
  back: vec4f,      // the people's depths: nearest, farthest (for the shadow's strength)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var forest: texture_2d_array<f32>;
@group(0) @binding(3) var personTex: texture_2d<f32>;
@group(0) @binding(4) var cardsTex: texture_2d_array<f32>; // 0: the contact card, 1: the signs
@group(0) @binding(5) var leavesTex: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

// covered and covered * distance at LED pixel pos (bilinear over the cells of the person image)
fn person(pos: vec2f) -> vec2f {
  let v = textureSampleLevel(personTex, samp, pos / u.res, 0.0);
  return vec2f(v.r, v.r * v.g);
}

@fragment fn fs(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let pos = floor(fp.xy) + 0.5;
  let ip = vec2i(pos);

  // the people, smoothed over a few LEDs: coverage and the (coverage-weighted) distance
  let r = u.soft * u.s;
  var acc = person(pos) * 0.2;
  acc += (person(pos + vec2f(r, 0.0)) + person(pos - vec2f(r, 0.0)) + person(pos + vec2f(0.0, r)) + person(pos - vec2f(0.0, r))) * 0.12;
  acc += (person(pos + vec2f(r, r) * 0.7) + person(pos - vec2f(r, r) * 0.7) + person(pos + vec2f(r, -r) * 0.7) + person(pos - vec2f(r, -r) * 0.7)) * 0.08;
  let cov = smoothstep(0.12, 0.7, acc.x);
  let dist = select(99.0, acc.y / max(acc.x, 1e-4), acc.x > 1e-3);
  // stronger near the sensor, misty far away; the feet fade into the forest floor a little
  var a = cov * mix(u.near, u.far, saturate((dist - u.back.x) / max(0.1, u.back.y - u.back.x)));
  a *= mix(0.6, 1.0, saturate((u.tint.w - pos.y) / (40.0 * u.s) + 0.4));

  // what lies at the signs' depth: the signs (premultiplied) and the heap (leaves, alpha 253)
  let sg = textureLoad(cardsTex, ip, 1, 0);
  let lv = textureLoad(leavesTex, ip, 0);
  let heap = lv.a > 0.99 && lv.a <= 0.994;
  // a shadow passing in front of a sign stays thin
  let aSign = select(a, min(a, 0.3), sg.a > 0.5 || heap);

  // the wood far to near, the signs at their depth, the person in between
  var col = textureLoad(forest, ip, 0, 0).rgb;
  var placed = false;
  var signs = false;
  for (var i = 1; i < ${LAYERS}; i++) {
    let dl = u.depth[i - 1];
    if (!signs && u.depth.w > dl) {
      if (!placed && dist > u.depth.w) {
        col = mix(col, u.tint.rgb, a);
        placed = true;
      }
      col = sg.rgb + col * (1.0 - sg.a);
      col = select(col, lv.rgb, heap);
      signs = true;
    }
    if (!placed && dist > dl) {
      col = mix(col, u.tint.rgb, select(a, aSign, signs));
      placed = true;
    }
    let l = textureLoad(forest, ip, i, 0);
    col = l.rgb + col * (1.0 - l.a);
  }
  if (!signs) {
    if (!placed && dist > u.depth.w) {
      col = mix(col, u.tint.rgb, a);
      placed = true;
    }
    col = sg.rgb + col * (1.0 - sg.a);
    col = select(col, lv.rgb, heap);
  }
  if (!placed) { col = mix(col, u.tint.rgb, aSign); }

  // the leaves in the air, the contact card, the leaves lying on it (opaque pixel art)
  col = select(col, lv.rgb, lv.a > 0.994 && lv.a <= 0.998);
  let c = textureLoad(cardsTex, ip, 0, 0);
  col = c.rgb + col * (1.0 - c.a);
  col = select(col, lv.rgb, lv.a > 0.998);
  return vec4f(col * u.bright, 1.0);
}
`;

export async function createRenderer(ctx) {
  const { device, format } = await ctx.webgpu();
  const module = await checkedModule(device, WGSL, `${ctx.scene}: render`);
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
  });
  const persons = await createPerspPersons(ctx);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const uniBuf = ctx.track(device.createBuffer({ label: 'birch u', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const uni = new Float32Array(20);

  let size = '';
  let forest = null;
  let cards = null;
  let leaves = null;
  let group = null;
  let personView = null;
  let generation = 0; // counts new textures: their content must be uploaded again

  function ensure(w, h) {
    if (size !== `${w}x${h}`) {
      size = `${w}x${h}`;
      for (const t of [forest, cards, leaves]) t?.destroy();
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
      forest = device.createTexture({ label: 'wood', size: [w, h, LAYERS], format: 'rgba8unorm', usage });
      cards = device.createTexture({ label: 'cards', size: [w, h, 2], format: 'rgba8unorm', usage });
      leaves = device.createTexture({ label: 'leaves', size: [w, h], format: 'rgba8unorm', usage });
      generation++;
      group = null;
    }
    if (group && personView === persons.view) return;
    personView = persons.view;
    group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: forest.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: personView },
        { binding: 4, resource: cards.createView({ dimension: '2d-array' }) },
        { binding: 5, resource: leaves.createView() },
      ],
    });
  }

  return {
    persons,
    get generation() {
      return generation;
    },
    ensure,
    /** the wood's layers (canvases, far to near) */
    setForest(layers) {
      ensure(layers[0].width, layers[0].height);
      layers.forEach((c, i) => device.queue.copyExternalImageToTexture({ source: c }, { texture: forest, origin: [0, 0, i], premultipliedAlpha: true }, [c.width, c.height]));
    },
    /** the contact card and the signs (canvases) */
    setCards(hero, signs) {
      ensure(hero.width, hero.height);
      [hero, signs].forEach((c, i) => device.queue.copyExternalImageToTexture({ source: c }, { texture: cards, origin: [0, 0, i], premultipliedAlpha: true }, [c.width, c.height]));
    },
    /** the leaves: RGBA, opaque pixels or 0 */
    setLeaves(bytes, w, h) {
      ensure(w, h);
      device.queue.writeTexture({ texture: leaves }, bytes, { bytesPerRow: w * 4 }, [w, h]);
    },
    /** o: { s, bright, near, far, soft, tint: [r, g, b], ground (px), depths: [3 tree layers, signs], back: [nearest, farthest depth of the people], slots (persp.js) } */
    render(view, o) {
      const w = ctx.width;
      const h = ctx.height;
      ensure(w, h);
      const enc = device.createCommandEncoder();
      persons.update(enc, o.slots);
      ensure(w, h);
      uni.set([w, h, ctx.time, o.s, o.bright, o.near, o.far, o.soft, ...o.tint, o.ground, ...o.depths, ...o.back, 0, 0]);
      device.queue.writeBuffer(uniBuf, 0, uni);
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
    },
    destroy() {
      for (const t of [forest, cards, leaves]) t?.destroy();
    },
  };
}
