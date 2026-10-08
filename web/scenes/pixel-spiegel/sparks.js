// Pixel sparks: small square pixels that fly off fast hands and feet in the person's outfit colors,
// drift upwards and blink out. Simulated in JavaScript (wall meters), drawn as instanced squares on
// top of the tile image, on whole LEDs.

import { checkedModule } from '/lib/shader-pass.js';
import { outfit, hexRgb } from './palettes.js';

const MAX = 800;
const FLOATS = 8; // x, y (LED px), size (LED px), alpha, r, g, b, unused
const LIMBS = ['leftHand', 'rightHand', 'leftAnkle', 'rightAnkle'];
const BODY = ['head', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftHand', 'rightHand', 'leftHip', 'rightHip'];

const WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> res: vec4f;
struct VOut { @builtin(position) pos: vec4f, @location(0) col: vec4f, };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) c: vec4f) -> VOut {
  var corner = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let size = max(1.0, round(a.z));
  let px = floor(a.xy - 0.5 * size) + corner[vi] * size; // on whole LEDs
  var out: VOut;
  out.pos = vec4f(px.x / res.x * 2.0 - 1.0, 1.0 - px.y / res.y * 2.0, 0.0, 1.0);
  out.col = vec4f(c.rgb, a.w);
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f { return vec4f(in.col.rgb * in.col.a, in.col.a); }
`;

export async function createSparks(ctx) {
  const { device, context, format } = await ctx.webgpu();
  const module = await checkedModule(device, WGSL, `${ctx.scene}: sparks`);
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: FLOATS * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
    },
  });
  const data = new Float32Array(MAX * FLOATS);
  const buffer = ctx.track(device.createBuffer({ label: 'sparks', size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }));
  const resBuf = ctx.track(device.createBuffer({ label: 'sparks res', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: resBuf } }] });

  const list = []; // { x, y, vx, vy (wall m, m/s), life, age, size (m), rgb }
  const carry = new Map(); // fractional spawns per person and limb
  const v = [0, 0, 0];
  const at = [0, 0, 0];

  function spawn(x, y, vx, vy, rgb, size, jitter = 0.6, life = 0.7 + Math.random() * 1.1) {
    if (list.length >= MAX) list.shift();
    const a = Math.random() * Math.PI * 2;
    const s = (0.25 + Math.random() * 0.75) * jitter;
    list.push({ x, y, vx: vx + Math.cos(a) * s, vy: vy + Math.sin(a) * s, life, age: 0, size, rgb });
  }
  const light = (c) => c.map((x) => x + (1 - x) * 0.45);

  function update() {
    const p = ctx.params;
    const wall = ctx.wall;
    const dt = Math.min(ctx.dt, 0.1);
    const cell = p.cell / 100;
    const seen = new Set();

    // spawn: limbs faster than the threshold throw pixels, more the faster they move
    for (const q of wall.persons) {
      const person = q.person;
      const o = outfit(q.id);
      const colors = [hexRgb(o.shirt), hexRgb(o.skin), hexRgb(o.hair), [1, 1, 1]];
      for (const name of LIMBS) {
        const key = `${q.id}:${name}`;
        seen.add(key);
        const vel = wall.jointVelocity(person, name, v);
        const pos = wall.joint(person, name, at);
        if (!vel || !pos) continue;
        const speed = Math.hypot(vel[0], vel[1]);
        const over = speed - p.sparkSpeed;
        let n = (carry.get(key) ?? 0) + (over > 0 ? over * 18 * p.sparks * dt : 0);
        while (n >= 1) {
          n -= 1;
          const rgb = colors[Math.floor(Math.random() * colors.length)];
          spawn(pos[0], pos[1], vel[0] * 0.45, vel[1] * 0.45, rgb, cell * (0.38 + Math.random() * 0.25));
        }
        carry.set(key, n);
      }
      // a few pixels always drift up from the body, slowly
      const key = `${q.id}:drift`;
      seen.add(key);
      let n = (carry.get(key) ?? 0) + p.drift * 1.5 * dt;
      while (n >= 1) {
        n -= 1;
        const pos = wall.joint(person, BODY[Math.floor(Math.random() * BODY.length)], at);
        if (!pos) continue;
        const rgb = light(colors[Math.floor(Math.random() * 3)]);
        const x = pos[0] + (Math.random() < 0.5 ? -1 : 1) * (0.14 + Math.random() * 0.22); // beside the body
        spawn(x, pos[1] + (Math.random() - 0.5) * 0.2, 0, 0.12 + Math.random() * 0.15, rgb, cell * (0.22 + Math.random() * 0.18), 0.12, 1.8 + Math.random() * 1.6);
      }
      carry.set(key, n);
    }
    for (const key of carry.keys()) if (!seen.has(key)) carry.delete(key);

    // move: drag, a slow drift upwards
    const drag = Math.exp(-2.2 * dt);
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      s.age += dt;
      if (s.age >= s.life) {
        list.splice(i, 1);
        continue;
      }
      s.vx *= drag;
      s.vy = s.vy * drag + 0.35 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }

  function render() {
    update();
    if (!list.length) return;
    const wall = ctx.wall;
    const ppm = wall.pxPerM[0];
    let n = 0;
    for (const s of list) {
      const t = s.age / s.life;
      // pixel-art fade: full, then blinking, then gone; the size shrinks in steps
      const alpha = t < 0.6 ? 1 : (Math.floor(s.age * 14) % 2 ? 0.25 : 0.9) * (1 - t) * 2.5;
      const size = s.size * ppm * (t < 0.5 ? 1 : 0.6);
      const [px, py] = wall.px([s.x, s.y]);
      data.set([px, py, size, Math.min(1, alpha), s.rgb[0], s.rgb[1], s.rgb[2], 0], n * FLOATS);
      n++;
    }
    device.queue.writeBuffer(resBuf, 0, new Float32Array([ctx.width, ctx.height, 0, 0]));
    device.queue.writeBuffer(buffer, 0, data, 0, n * FLOATS);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, buffer);
    pass.draw(6, n);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  return {
    render,
    get count() {
      return list.length;
    },
  };
}
