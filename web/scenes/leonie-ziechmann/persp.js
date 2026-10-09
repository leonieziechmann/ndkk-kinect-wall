// The people in perspective: this scene's own projection instead of the shared wall mapping.
//
//   sideways  by the angle in the Kinect's view: its left and right edge are the wall's edges at
//             every distance, so far back one has to walk further to cross the wall (parallax,
//             the view widens with the distance just like the sensor's)
//   size      shrinks with the distance (1 / z), the body keeps its proportions
//   height    the feet rise towards the horizon the farther away someone stands, onto the farther
//             hills of the wood
//   depth     with `back` the people walk only in the back of the wood: the real distance from
//             the sensor (1..4 m) becomes a depth in the wood (back[0]..back[1], e.g. 3.0..5.5 m),
//             so the nearest walk on the hills of the far trees, behind the signs and the mid and
//             near rows; size, feet and the order between the trees follow that depth
//
// Every person is placed as a whole: its body center gives the place and the scale, its pixels
// are drawn around it. JS (Perspective) computes the per-person placement and also hands it to the
// leaves, the heap and the body field; the GPU (createPerspPersons) projects the person pixels into
// a texture like lib/wall-persons.js does (r covered, g depth in the wood, b slot, a IR).

import { wallWgsl } from '/lib/wall.js';
import { checkedModule } from '/lib/shader-pass.js';

const CELL_PX = 2;
const SLOTS = 17;
const TAN_H = 0.708; // Kinect v2: half the horizontal field of view, tan(35.3°)

/**
 * The placement. configure(p, L, wall, feet): p: params (spread: how much of the wall the view
 * spans, nearSize: size at the near anchor, 1 = real), feet: two anchors [[z m, y design px], ...]
 * where the feet stand (on the wood's ground). place(lat, z) -> { x px, feet px, scale px/m } for
 * a body center `lat` m beside the sensor (in the wall's direction) at `z` m from it.
 */
export class Perspective {
  constructor() {
    this.track = new Map(); // id -> { x, vx } smoothed, for the speed across the wall
    this.places = [];
    this.slots = new Float32Array(SLOTS * 8); // per slot: x px, feet px, px per m, lat; depth shift
  }

  configure(p, L, wall, feet) {
    const S = wall.setup;
    this.W = L.W;
    this.H = L.H;
    this.kx = L.W / S.size.w;
    this.ky = L.H / S.size.h;
    this.top = S.bottom + S.size.h;
    this.pxPerM = L.H / S.size.h;
    this.spread = p.spread;
    this.margin = 0.03;
    const [[nearZ, yNear], [farZ, yFar]] = feet;
    // feet: y = yh + A / z (a pinhole looking along the floor); size: scale = f / z (px per m)
    this.A = ((yNear - yFar) * L.s) / (1 / nearZ - 1 / farZ);
    this.yh = yFar * L.s - this.A / farZ;
    this.f = p.nearSize * this.pxPerM * nearZ;
    this.minZ = 0.8;
    // only in the back of the wood: real 1..4 m -> back[0]..back[1]
    this.back = p.backWood ? [p.backNear, Math.max(p.backNear + 0.1, p.backFar)] : null;
  }

  /** the depth in the wood (m) for a real distance z from the sensor */
  depth(z) {
    if (!this.back) return z;
    const t = (z - 1) / 3;
    return Math.max(this.back[0] - 0.05, this.back[0] + t * (this.back[1] - this.back[0]));
  }

  place(lat, z) {
    const zz = Math.max(this.minZ, z);
    let u = 0.5 + (lat / (2 * zz * TAN_H)) * this.spread;
    u = Math.min(1 - this.margin, Math.max(this.margin, u));
    const zv = Math.max(this.minZ, this.depth(z));
    return { x: u * this.W, feet: this.yh + this.A / zv, scale: this.f / zv, depth: zv };
  }

  /**
   * The people of this frame: per visible person its placement on the wall (px and wall m, like
   * ctx.wall.persons: x, feet, top, vx, dist, id, slot, inZone) and the GPU slot data.
   */
  update(ctx) {
    const wall = ctx.wall;
    const dt = Math.max(1e-3, Math.min(0.1, ctx.dt));
    this.slots.fill(0);
    const out = [];
    const seen = new Set();
    for (const pl of wall.persons) {
      if (!pl.inZone || !pl.room) continue;
      const lat = wall.side * pl.room[0];
      const z = pl.room[2];
      const q = this.place(lat, z);
      const xm = q.x / this.kx;
      let tr = this.track.get(pl.id);
      if (!tr) {
        tr = { x: xm, vx: 0 };
        this.track.set(pl.id, tr);
      } else {
        const a = 1 - Math.exp(-dt / 0.25);
        tr.vx += ((xm - tr.x) / dt - tr.vx) * a;
        tr.x = xm;
      }
      seen.add(pl.id);
      const feetM = this.top - q.feet / this.ky;
      const headH = Math.max(0.5, pl.top - pl.feet); // real height of the head above the feet
      const sc = q.scale / this.ky; // m on the wall per m of the person
      out.push({
        person: pl.person,
        id: pl.id,
        slot: pl.slot,
        x: xm,
        y: feetM + (pl.y - pl.feet) * sc,
        feet: feetM,
        top: feetM + headH * sc,
        vx: tr.vx,
        dist: z,
        depth: q.depth,
        scale: sc,
        px: q.x,
        inZone: true,
      });
      if (pl.slot > 0 && pl.slot < SLOTS) this.slots.set([q.x, q.feet, q.scale, lat, q.depth - z, 0, 0, 0], pl.slot * 8);
    }
    for (const id of this.track.keys()) if (!seen.has(id)) this.track.delete(id);
    this.places = out;
    return out;
  }

  /** for the body field (CPU): a person pixel of `slot` at room (lat, y, z) -> wall m [x, y], or null */
  project(slot, lat, ry) {
    const o = slot * 8;
    const scale = this.slots[o + 2];
    if (!scale) return null;
    return [(this.slots[o] + (lat - this.slots[o + 3]) * scale) / this.kx, this.top - (this.slots[o + 1] - ry * scale) / this.ky];
  }
}

const WGSL = /* wgsl */ `
${wallWgsl(0, 0)}
@group(0) @binding(1) var personLabel: texture_2d<u32>;
@group(0) @binding(2) var personDepth: texture_2d<f32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var irTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> cells: array<atomic<u32>>;
@group(0) @binding(6) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var<uniform> grid: vec4u; // cells wide, high, LED px per cell
@group(0) @binding(8) var<uniform> place: array<vec4f, ${SLOTS * 2}>; // per slot: x px, feet px, px per m, lat of the center; depth shift

const EMPTY = 0xffffffffu;

// every person pixel -> its cell around its person's place; the nearest point wins
@compute @workgroup_size(8, 8)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(personDepth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let slot = textureLoad(personLabel, p, 0).r;
  let z = textureLoad(personDepth, p, 0).r;
  if (slot == 0u || z < 0.1) { return; }
  let a = place[min(slot, ${SLOTS - 1}u) * 2u];
  let dz = place[min(slot, ${SLOTS - 1}u) * 2u + 1u].x;
  if (a.z <= 0.0) { return; }
  let ray = textureLoad(lutTex, p, 0).rg;
  let world = vec3f(WALL.xSign * ray.x * z, -ray.y * z, z);
  let room = wallRoom(world);
  if (!wallInZone(room)) { return; }
  let lat = WALL.side * room.x;
  let px = vec2f(a.x + (lat - a.w) * a.z, a.y - room.y * a.z);
  let c = vec2i(floor(px / f32(grid.z)));
  if (any(c < vec2i(0)) || any(c >= vec2i(grid.xy))) { return; }
  let mm = u32(clamp(room.z + dz, 0.0, 60.0) * 1000.0);
  let ir = u32(saturate(textureLoad(irTex, p, 0).r) * 255.0);
  atomicMin(&cells[u32(c.y) * grid.x + u32(c.x)], (mm << 13u) | (ir << 5u) | min(slot, 31u));
}

fn cellAt(c: vec2i) -> u32 {
  if (any(c < vec2i(0)) || any(c >= vec2i(grid.xy))) { return EMPTY; }
  return atomicLoad(&cells[u32(c.y) * grid.x + u32(c.x)]);
}

// cells -> texture; a hole with people all around takes the nearest neighbour
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

/** The person pixels in perspective, as a texture over the LED image (see the top). */
export async function createPerspPersons(ctx) {
  const { device } = await ctx.webgpu();
  const gpu = ctx.kinect.gpu;
  const wall = ctx.wall;
  const module = await checkedModule(device, WGSL, `${ctx.scene}: persp`);
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
      { binding: 8, visibility: C, buffer: { type: 'uniform' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipes = Object.fromEntries(['scatter', 'resolve', 'clear'].map((e) => [e, device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: e } })]));
  const gridBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const placeBuf = device.createBuffer({ size: SLOTS * 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const views = [gpu.personLabelTexture.createView(), gpu.personDepthTexture.createView(), gpu.lutTexture.createView(), gpu.irTexture.createView()];

  let r = null;
  let lastSeq = null;
  let cleared = false;
  const pp = {
    view: null,
    w: 0,
    h: 0,
    ensure() {
      const w = Math.max(8, Math.round(wall.setup.led.w / CELL_PX));
      const h = Math.max(8, Math.round(wall.setup.led.h / CELL_PX));
      if (r && r.w === w && r.h === h) return false;
      r?.cells.destroy();
      r?.tex.destroy();
      const cells = device.createBuffer({ size: w * h * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(cells, 0, new Uint32Array(w * h).fill(0xffffffff));
      const tex = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
      device.queue.writeBuffer(gridBuf, 0, new Uint32Array([w, h, CELL_PX, 0]));
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: wall.buffer(device) } },
          ...views.map((v, i) => ({ binding: i + 1, resource: v })),
          { binding: 5, resource: { buffer: cells } },
          { binding: 6, resource: tex.createView() },
          { binding: 7, resource: { buffer: gridBuf } },
          { binding: 8, resource: { buffer: placeBuf } },
        ],
      });
      r = { w, h, cells, tex, group };
      this.view = tex.createView();
      this.w = w;
      this.h = h;
      lastSeq = null;
      return true;
    },
    /** Projects the newest person result with the placements `slots` (Perspective.slots). */
    update(encoder, slots) {
      this.ensure();
      const k = ctx.kinect;
      const seq = k.persons?.seq ?? null;
      const stale = !k.persons || !k.depth || k.ageMs(k.depth) > 1000;
      if (seq === lastSeq && !stale) return false;
      if (stale && cleared) return false;
      lastSeq = seq;
      device.queue.writeBuffer(placeBuf, 0, slots);
      const pass = encoder.beginComputePass();
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
      cleared = stale;
      return true;
    },
    destroy() {
      r?.cells.destroy();
      r?.tex.destroy();
      gridBuf.destroy();
      placeBuf.destroy();
      r = null;
    },
  };
  pp.ensure();
  ctx.onDispose(() => pp.destroy());
  return pp;
}
