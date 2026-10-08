// wall-persons.js — the people as they fall on the LED wall: every person pixel of the Kinect is put
// into the room and mapped onto the wall (ctx.wall: mirror, stretch, per-person shift), the nearest
// one per wall cell wins. The result is a texture over the LED image (uv 0..1, y down):
//
//   r  covered: 1 where a person is (sample it linearly for soft edges)
//   g  distance of that person point from the sensor (m, along the floor)
//   b  slot of the person (1..16, 0 = nobody; read it with textureLoad, not filtered)
//   a  infrared brightness 0..1
//
// A person covers as much wall as they are wide, at the place the mapping gives them, whether near
// the sensor or far away (meters, not pixels). Single holes between the depth pixels are filled.
// 2D shaders get it through createShaderPass (wallPerson(uv), wallPersonMask(uv), wallPersonAt(uv));
// own pipelines: const wp = createWallPersons(ctx); wp.update(encoder); bind wp.view.

import { wallWgsl } from './wall.js';

const CELL_PX = 2; // LED pixels per cell: 504 x 168 cells on the 1008 x 336 wall

const WGSL = /* wgsl */ `
${wallWgsl(0, 0)}
@group(0) @binding(1) var personLabel: texture_2d<u32>;
@group(0) @binding(2) var personDepth: texture_2d<f32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var irTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> cells: array<atomic<u32>>;
@group(0) @binding(6) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var<uniform> grid: vec4u; // cells wide, high

const EMPTY = 0xffffffffu;

// every person pixel -> its wall cell; the nearest point wins: (mm << 13) | (ir << 5) | slot
@compute @workgroup_size(8, 8)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(personDepth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let slot = textureLoad(personLabel, p, 0).r;
  let z = textureLoad(personDepth, p, 0).r;
  if (slot == 0u || z < 0.1) { return; }
  let ray = textureLoad(lutTex, p, 0).rg;
  let world = vec3f(WALL.xSign * ray.x * z, -ray.y * z, z);
  let room = wallRoom(world);
  if (!wallInZone(room)) { return; }
  let uv = wallUv(wallFromRoom(room, slot));
  if (!wallOnWall(uv)) { return; }
  let g = min(vec2u(uv * vec2f(grid.xy)), grid.xy - 1u);
  let mm = u32(clamp(room.z, 0.0, 60.0) * 1000.0);
  let ir = u32(saturate(textureLoad(irTex, p, 0).r) * 255.0);
  atomicMin(&cells[g.y * grid.x + g.x], (mm << 13u) | (ir << 5u) | min(slot, 31u));
}

fn cellAt(c: vec2i) -> u32 {
  if (any(c < vec2i(0)) || any(c >= vec2i(grid.xy))) { return EMPTY; }
  return atomicLoad(&cells[u32(c.y) * grid.x + u32(c.x)]);
}

// cells -> texture; a hole with people all around takes the nearest neighbour. Clears are done in
// the next pass (clear), after every cell has been read.
@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= grid.x || id.y >= grid.y) { return; }
  let c = vec2i(id.xy);
  var v = cellAt(c);
  if (v == EMPTY) {
    var n = 0u;
    var best = EMPTY;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        if (x == 0 && y == 0) { continue; }
        let w = cellAt(c + vec2i(x, y));
        if (w != EMPTY) {
          n++;
          best = min(best, w);
        }
      }
    }
    if (n >= 5u) { v = best; }
  }
  if (v == EMPTY) {
    textureStore(outTex, c, vec4f(0.0));
    return;
  }
  textureStore(outTex, c, vec4f(1.0, f32(v >> 13u) / 1000.0, f32(v & 31u), f32((v >> 5u) & 255u) / 255.0));
}

@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < grid.x * grid.y) { atomicStore(&cells[id.x], EMPTY); }
}
`;

/**
 * The wall image of the people for the current scene (after ctx.webgpu()). update() runs once per
 * person tracking result (call it every frame; it skips frames without new data).
 */
export async function createWallPersons(ctx, { cellPx = CELL_PX } = {}) {
  const { device } = await ctx.webgpu();
  const gpu = ctx.kinect.gpu;
  const wall = ctx.wall;
  const module = device.createShaderModule({ label: 'wall persons', code: WGSL });
  const info = await module.getCompilationInfo();
  const bad = info.messages.find((m) => m.type === 'error');
  if (bad) throw new Error(`wall-persons.js WGSL: ${bad.message} (Zeile ${bad.lineNum})`);
  const C = GPUShaderStage.COMPUTE;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, texture: { sampleType: 'uint' } },
      { binding: 2, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: C, texture: { sampleType: 'float' } },
      { binding: 5, visibility: C, buffer: { type: 'storage' } },
      { binding: 6, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      { binding: 7, visibility: C, buffer: { type: 'uniform' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipes = Object.fromEntries(['scatter', 'resolve', 'clear'].map((e) => [e, device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: e } })]));
  const gridBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const views = [gpu.personLabelTexture.createView(), gpu.personDepthTexture.createView(), gpu.lutTexture.createView(), gpu.irTexture.createView()];

  let r = null; // size-dependent resources
  let lastSeq = null;
  let cleared = false;
  const wp = {
    view: null,
    texture: null,
    w: 0,
    h: 0,
    ensure() {
      const w = Math.max(8, Math.round(wall.setup.led.w / cellPx));
      const h = Math.max(8, Math.round(wall.setup.led.h / cellPx));
      if (r && r.w === w && r.h === h) return false;
      r?.cells.destroy();
      r?.tex.destroy();
      const cells = device.createBuffer({ size: w * h * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(cells, 0, new Uint32Array(w * h).fill(0xffffffff));
      const tex = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
      device.queue.writeBuffer(gridBuf, 0, new Uint32Array([w, h, 0, 0]));
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: wall.buffer(device) } },
          ...views.map((v, i) => ({ binding: i + 1, resource: v })),
          { binding: 5, resource: { buffer: cells } },
          { binding: 6, resource: tex.createView() },
          { binding: 7, resource: { buffer: gridBuf } },
        ],
      });
      r = { w, h, cells, tex, group };
      this.texture = tex;
      this.view = tex.createView();
      this.w = w;
      this.h = h;
      lastSeq = null;
      return true; // a new texture: bind groups that use .view must be made again
    },
    /** Projects the newest person tracking result (once per result); returns true if it did. */
    update(encoder = null) {
      this.ensure();
      const k = ctx.kinect;
      const seq = k.persons?.seq ?? null;
      const stale = !k.persons || !k.depth || k.ageMs(k.depth) > 1000; // no people data: an empty wall
      if (seq === lastSeq && !stale) return false;
      if (stale && cleared) return false;
      lastSeq = seq;
      const enc = encoder ?? device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, r.group);
      if (!stale) {
        pass.setPipeline(pipes.scatter);
        pass.dispatchWorkgroups(Math.ceil(512 / 8), Math.ceil(424 / 8));
      }
      pass.setPipeline(pipes.resolve);
      pass.dispatchWorkgroups(Math.ceil(r.w / 8), Math.ceil(r.h / 8));
      pass.setPipeline(pipes.clear);
      pass.dispatchWorkgroups(Math.ceil((r.w * r.h) / 64));
      pass.end();
      if (!encoder) device.queue.submit([enc.finish()]);
      cleared = stale;
      return true;
    },
    destroy() {
      r?.cells.destroy();
      r?.tex.destroy();
      gridBuf.destroy();
      r = null;
    },
  };
  wp.ensure();
  ctx.onDispose(() => wp.destroy());
  return wp;
}
