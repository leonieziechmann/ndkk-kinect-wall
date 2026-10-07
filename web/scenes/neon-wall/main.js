// Fluid on an LED wall (6 m x 2 m, 1008 x 336 LEDs), stirred by the people in front of it.
// Built on the person tracking (/lib/persons.js, PERSONS.md) in live mode: only the people's pixels
// count. Their motion is measured on the masks (exact in every frame): an optical flow of the
// people's camera image, turned into meters per second with the depth. Every motion sample is put
// into the room (the tracker finds the floor) and projected straight onto the wall. Where a person
// stands and how fast they move counts in meters: standing closer to the sensor gives no more
// influence, standing still shows nothing. The skeleton says which pixels are arms: they count more
// and reach further. Dye is colored by distance by default. Dragging the mouse works too.
//
// Per person tracking result (camera.wgsl, kinect.wgsl, sim.wgsl):
//   prep -> camSignal -> down, down -> lkCoarse -> lkRefine -> lkFinal   optical flow, 3 levels
//   nearest, project, collect                                           wall image (front surface)
//   scene, vcollect                                                     3D motion -> wall
//   wallSignal, wallMotion                                              smoothing on the wall
// Per render frame: force, dye, curl, vorticity, divergence, pressure (Jacobi), gradient,
// advection (dye: MacCormack), display.

import { checkedModule } from '/lib/shader-pass.js';
import { POINTS, BONES, DEFAULT_DELAY } from '/lib/persons.js';
import COMMON from './common.wgsl?raw';
import KINECT from './kinect.wgsl?raw';
import CAMERA from './camera.wgsl?raw';
import SIM from './sim.wgsl?raw';

// the uniforms, all f32; struct Uni in WGSL is generated from this list
const FIELDS = [
  'simW', 'simH', 'dyeW', 'dyeH', 'gridW', 'gridH', 'screenW', 'screenH',
  'mouseX', 'mouseY', 'mouseDX', 'mouseDY', 'mouseDown', 'dt', 'time', 'xSign',
  'wallW', 'wallH', 'wallBottom', 'camX', 'zoneNear', 'zoneFar',
  'threshold', 'flowGain', 'force', 'wallSmooth', 'irMix', 'motionOn', 'armGain', 'armBrush',
  'coherence', 'lambda', 'flowSmooth', 'frameStep',
  'fillTarget', 'balanceOn', 'hueBySpeed', 'personHue',
  'curl', 'velDiss', 'dyeDiss', 'fade', 'pressureDecay',
  'colorMode', 'hueSpeed', 'dyeAmount', 'exposure', 'shading', 'splatRadius', 'tintR', 'tintG', 'tintB',
  'showPeople', 'showSkeleton', 'showFlow', 'viewMode',
];
// bones of the arms (touching an elbow, wrist or hand), as a bit mask over BONES
const ARM_BONES = BONES.reduce((m, [a, b], i) => (/Elbow|Wrist|Hand/.test(POINTS[a]) || /Elbow|Wrist|Hand/.test(POINTS[b]) ? m | (1 << i) : m), 0);
const HEAD = [
  `struct Uni {\n${FIELDS.map((f) => `  ${f}: f32,`).join('\n')}\n};`,
  `const POINT_COUNT = ${POINTS.length}u;`,
  `const BONE_COUNT = ${BONES.length}u;`,
  `const ARM_BONES = ${ARM_BONES}u;`,
  `var<private> BONES: array<vec2u, ${BONES.length}> = array<vec2u, ${BONES.length}>(${BONES.map(([a, b]) => `vec2u(${a}u, ${b}u)`).join(', ')});`,
  '',
].join('\n');
// skeleton buffer (see common.wgsl): room matrix, then per slot 0..16 and point one vec4f, then per slot one
const SKEL_JOINTS = 4;
const SKEL_PERSONS = SKEL_JOINTS + 17 * POINTS.length;
const SKEL_SIZE = (SKEL_PERSONS + 17) * 16;
const DEPTH = { w: 512, h: 424 };
const FLOW = { w: 128, h: 106 }; // optical flow, finest level; then 64x53 and 32x27
const GRID_ROWS = 64; // wall cells: 64 rows = about 3 cm per cell on a 2 m wall

let S = null; // everything setup() creates

/** World -> room without a found floor: the sensor camH above the floor, tilted down by tiltDeg. */
function manualRoom(camH, tiltDeg) {
  const t = (tiltDeg * Math.PI) / 180;
  const up = [0, Math.cos(t), -Math.sin(t)];
  const fwd = [0, Math.sin(t), Math.cos(t)];
  const m = new Float32Array(16);
  for (let j = 0; j < 3; j++) {
    m[j * 4] = j === 0 ? 1 : 0;
    m[j * 4 + 1] = up[j];
    m[j * 4 + 2] = fwd[j];
  }
  m[13] = camH;
  m[15] = 1;
  return m;
}
/** IEEE half float (u16) -> number */
function half(x) {
  const e = (x >> 10) & 31;
  const f = x & 1023;
  const v = e ? (1 + f / 1024) * 2 ** (e - 15) : (f / 1024) * 2 ** -14;
  return x & 0x8000 ? -v : v;
}
const roomPoint = (m, w) => [0, 1, 2].map((r) => m[r] * w[0] + m[4 + r] * w[1] + m[8 + r] * w[2] + m[12 + r]);

export default {
  streams: ['persons'], // depth and ir come with it
  persons: (p) => ({ mode: 'full', delay: p.live ? 0 : DEFAULT_DELAY }),
  pixelRatio: 1, // canvas pixels = screen pixels, so "LED pixelgenau" really is one LED per pixel
  // the person tracking (pose model) and the Kinect's depth decoding share the GPU
  maxFps: 30,

  params: {
    viewMode: { value: 0, options: { Vorschau: 0, 'LED pixelgenau': 1 }, label: 'Ansicht', folder: 'Wand' },
    showPeople: { value: false, label: 'Personen + 1-m-Raster', folder: 'Wand' },
    showSkeleton: { value: false, label: 'Skelette zeigen', folder: 'Wand' },
    ledW: { value: 1008, min: 64, max: 4096, step: 1, label: 'LEDs breit', folder: 'Wand' },
    ledH: { value: 336, min: 32, max: 2048, step: 1, label: 'LEDs hoch', folder: 'Wand' },
    wallW: { value: 6, min: 1, max: 20, step: 0.1, label: 'Wand breit (m)', folder: 'Wand' },
    wallH: { value: 2, min: 0.5, max: 8, step: 0.1, label: 'Wand hoch (m)', folder: 'Wand' },
    wallBottom: { value: 0, min: 0, max: 3, step: 0.05, label: 'Wand Unterkante (m)', folder: 'Wand' },
    camX: { value: 0, min: -10, max: 10, step: 0.05, label: 'Kinect seitlich (m)', folder: 'Wand' },
    zoneNear: { value: 0.3, min: 0.3, max: 4, step: 0.05, label: 'Zone ab (m)', folder: 'Wand' },
    zoneFar: { value: 4.5, min: 1, max: 8, step: 0.1, label: 'Zone bis (m)', folder: 'Wand' },
    camH: { value: 0.8, min: 0, max: 4, step: 0.05, label: 'Kinect Höhe (ohne Boden, m)', folder: 'Wand' },
    camTilt: { value: 0, min: -45, max: 45, step: 0.5, label: 'Neigung (ohne Boden, °)', folder: 'Wand' },

    live: { value: true, label: 'Live (weniger Verzögerung)', folder: 'Bewegung' },
    force: { value: 10, min: 0, max: 40, step: 0.5, label: 'Mitnahme', folder: 'Bewegung' },
    flowGain: { value: 1.5, min: 0.2, max: 5, step: 0.05, label: 'Verstärkung', folder: 'Bewegung' },
    threshold: { value: 0.3, min: 0, max: 3, step: 0.05, label: 'Schwelle (m/s)', folder: 'Bewegung' },
    armGain: { value: 2, min: 1, max: 5, step: 0.1, label: 'Arme verstärken', folder: 'Bewegung' },
    armBrush: { value: 0.25, min: 0, max: 0.6, step: 0.01, label: 'Arm-Reichweite (m)', folder: 'Bewegung' },
    coherence: { value: 0.5, min: 0, max: 0.95, step: 0.01, label: 'Richtungstreue', folder: 'Bewegung' },
    flowSmooth: { value: 0.4, min: 0, max: 0.9, step: 0.01, label: 'Glättung', folder: 'Bewegung' },
    denoise: { value: 8, min: 0.1, max: 30, step: 0.1, label: 'Rauschfilter', folder: 'Bewegung' },
    balanceOn: { value: true, label: 'Automatisch ausgleichen', folder: 'Bewegung' },
    fillTarget: { value: 0.3, min: 0.05, max: 0.8, step: 0.01, label: 'Füllung (Ziel)', folder: 'Bewegung' },
    wallSmooth: { value: 0.3, min: 0, max: 0.9, step: 0.01, label: 'Wandbild glätten', folder: 'Bewegung' },
    irMix: { value: 0.3, min: 0, max: 1, step: 0.01, label: 'IR-Anteil (Farbe)', folder: 'Bewegung' },

    curl: { value: 20, min: 0, max: 80, step: 1, label: 'Wirbel', folder: 'Fluid' },
    velDiss: { value: 0.3, min: 0, max: 4, step: 0.05, label: 'Bremsen', folder: 'Fluid' },
    dyeDiss: { value: 0.5, min: 0, max: 4, step: 0.05, label: 'Verblassen', folder: 'Fluid' },
    fade: { value: 0.06, min: 0, max: 0.5, step: 0.01, label: 'Ausklingen', folder: 'Fluid' },
    pressureIters: { value: 24, min: 4, max: 60, step: 1, label: 'Druck-Iterationen', folder: 'Fluid' },
    pressureDecay: { value: 0.8, min: 0, max: 1, step: 0.01, label: 'Druck halten', folder: 'Fluid' },
    simRes: { value: 112, options: [84, 112, 168], label: 'Auflösung Strömung', folder: 'Fluid' },

    colorMode: { value: 0, options: { Tiefe: 0, Person: 1, Neon: 2, Regenbogen: 3, Einfarbig: 4 }, label: 'Farben' },
    tint: { value: '#4fb4ff', label: 'Einfarbig' },
    hueSpeed: { value: 0.04, min: -0.5, max: 0.5, step: 0.01, label: 'Farbdrift' },
    hueBySpeed: { value: 0.2, min: 0, max: 0.5, step: 0.01, label: 'Farbe nach Tempo' },
    personHue: { value: 0.3, min: 0, max: 0.5, step: 0.01, label: 'Farbe je Person' },
    dyeAmount: { value: 2, min: 0, max: 4, step: 0.05, label: 'Farbmenge' },
    exposure: { value: 1.8, min: 0.2, max: 5, step: 0.05, label: 'Helligkeit' },
    shading: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Relief' },
    splatRadius: { value: 0.03, min: 0.005, max: 0.2, step: 0.005, label: 'Maus-Radius' },
    showFlow: { value: false, label: 'Fluss zeigen' },
  },

  async setup(ctx) {
    const { device, context, format } = await ctx.webgpu();
    const gpu = ctx.kinect.gpu;
    const head = `${HEAD}${COMMON}`;
    const lines = head.split('\n').length;
    const simModule = await checkedModule(device, `${head}\n${SIM}\n${CAMERA}`, 'neon-wall sim.wgsl + camera.wgsl', lines);
    const kinectModule = await checkedModule(device, `${head}\n${KINECT}`, 'neon-wall kinect.wgsl', lines);

    const C = GPUShaderStage.COMPUTE;
    const F = GPUShaderStage.FRAGMENT;
    const storage = { access: 'write-only', format: 'rgba16float' };
    const skelEntry = (visibility) => ({ binding: 10, visibility, buffer: { type: 'read-only-storage' } });
    const simLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, texture: { sampleType: 'float' } },
        { binding: 2, visibility: C, texture: { sampleType: 'float' } },
        { binding: 3, visibility: C, sampler: { type: 'filtering' } },
        { binding: 4, visibility: C, storageTexture: storage },
        { binding: 5, visibility: C, texture: { sampleType: 'float' } },
        skelEntry(C),
        { binding: 11, visibility: C, texture: { sampleType: 'float' } },
      ],
    });
    const kinectLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: C, texture: { sampleType: 'uint' } },
        { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: C, texture: { sampleType: 'float' } },
        { binding: 5, visibility: C, buffer: { type: 'storage' } },
        { binding: 6, visibility: C, storageTexture: storage },
        { binding: 7, visibility: C, buffer: { type: 'storage' } },
        { binding: 8, visibility: C, storageTexture: storage },
        { binding: 9, visibility: C, texture: { sampleType: 'float' } },
        skelEntry(C),
        { binding: 11, visibility: C, texture: { sampleType: 'float' } },
        { binding: 12, visibility: C, storageTexture: storage },
      ],
    });
    const displayLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: F, sampler: { type: 'filtering' } },
        { binding: 5, visibility: F, texture: { sampleType: 'float' } },
        skelEntry(F),
      ],
    });

    device.pushErrorScope('validation');
    const simPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [simLayout] });
    const kinectPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [kinectLayout] });
    const pipes = {};
    const simEntries = ['camSignal', 'down', 'lkCoarse', 'lkRefine', 'lkFinal', 'dyeStats', 'wallSignal', 'wallMotion', 'force', 'dye', 'curl', 'vorticity', 'divergence', 'pressureFade', 'jacobi', 'gradient', 'advectVel', 'advect', 'maccormackDye'];
    for (const name of simEntries) pipes[name] = device.createComputePipeline({ layout: simPipelineLayout, compute: { module: simModule, entryPoint: name } });
    for (const name of ['prep', 'nearest', 'project', 'scene', 'collect', 'vcollect']) {
      pipes[name] = device.createComputePipeline({ layout: kinectPipelineLayout, compute: { module: kinectModule, entryPoint: name } });
    }
    const display = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [displayLayout] }),
      vertex: { module: simModule, entryPoint: 'vs' },
      fragment: { module: simModule, entryPoint: 'display', targets: [{ format }] },
    });
    const err = await device.popErrorScope();
    if (err) throw new Error(`Pipeline: ${err.message}`);

    const uniformBuf = ctx.track(device.createBuffer({ size: Math.ceil(FIELDS.length / 4) * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const skelBuf = ctx.track(device.createBuffer({ size: SKEL_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const views = {
      personDepth: gpu.personDepthTexture.createView(),
      personLabel: gpu.personLabelTexture.createView(),
      lut: gpu.lutTexture.createView(),
      ir: gpu.irTexture.createView(),
    };

    let nextId = 0;
    const owned = new Set(); // size depends on params, see ensure()
    const camOwned = new Set(); // camera image, fixed size
    const makeTex = (w, h, set = owned) => {
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | (w === 1 ? GPUTextureUsage.COPY_SRC : 0);
      const tex = device.createTexture({ size: [w, h], format: 'rgba16float', usage });
      set.add(tex);
      return { tex, view: tex.createView(), id: nextId++, w, h };
    };
    const pair = (w, h, set = owned) => ({
      read: makeTex(w, h, set),
      write: makeTex(w, h, set),
      swap() {
        [this.read, this.write] = [this.write, this.read];
      },
    });
    const half = (n) => Math.ceil(n / 2);
    const cam = {
      prep: makeTex(DEPTH.w, DEPTH.h, camOwned),
      sig: pair(FLOW.w, FLOW.h, camOwned),
      sig1: makeTex(half(FLOW.w), half(FLOW.h), camOwned),
      sig2: makeTex(half(half(FLOW.w)), half(half(FLOW.h)), camOwned),
      flow2: makeTex(half(half(FLOW.w)), half(half(FLOW.h)), camOwned),
      flow1: makeTex(half(FLOW.w), half(FLOW.h), camOwned),
      flow: pair(FLOW.w, FLOW.h, camOwned),
    };

    S = {
      device,
      context,
      pipes,
      display,
      uniformBuf,
      skelBuf,
      uni: new Float32Array(uniformBuf.size / 4),
      skel: new Float32Array(SKEL_SIZE / 4),
      cam,
      lastSeq: null,
      r: null, // wall resources, see ensure()
      groups: new Map(),
      mouse: { x: 0, y: 0, vx: 0, vy: 0 },
      lastPersons: -1,
      // fill and balance gain for the status line, read back from the GPU twice a second
      readback: device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      reading: false,
      lastRead: 0,
      fill: 0,
      gain: 1,
      // bind group per (layout, inputs, output), cached. sim: a, b, c sampled, out storage (c: the
      // third input, MacCormack). kinect: out storage, everything else fixed or the current camera flow.
      group(kind, a, b, out, c = a) {
        const key = `${kind}:${a?.id}:${b?.id}:${out?.id}:${c?.id}:${this.r.stats.read.id}:${cam.flow.read.id}:${cam.sig.read.id}`;
        let g = this.groups.get(key);
        if (!g) {
          const buffer = { binding: 0, resource: { buffer: uniformBuf } };
          const skelRes = { binding: 10, resource: { buffer: skelBuf } };
          const entries = {
            kinect: () => [
              buffer,
              { binding: 1, resource: views.personDepth },
              { binding: 2, resource: views.personLabel },
              { binding: 3, resource: views.lut },
              { binding: 4, resource: views.ir },
              { binding: 5, resource: { buffer: this.r.cells } },
              { binding: 6, resource: out.view },
              { binding: 7, resource: { buffer: this.r.vcells } },
              { binding: 8, resource: this.r.rawMotion.view },
              { binding: 9, resource: cam.flow.read.view },
              skelRes,
              { binding: 11, resource: cam.sig.read.view },
              { binding: 12, resource: this.r.rawArm.view },
            ],
            sim: () => [
              buffer,
              { binding: 1, resource: a.view },
              { binding: 2, resource: b.view },
              { binding: 3, resource: sampler },
              { binding: 4, resource: out.view },
              { binding: 5, resource: c.view },
              skelRes,
              { binding: 11, resource: this.r.stats.read.view },
            ],
            display: () => [buffer, { binding: 1, resource: a.view }, { binding: 2, resource: b.view }, { binding: 3, resource: sampler }, { binding: 5, resource: c.view }, skelRes],
          }[kind]();
          const layout = { kinect: kinectLayout, sim: simLayout, display: displayLayout }[kind];
          g = device.createBindGroup({ layout, entries });
          this.groups.set(key, g);
        }
        return g;
      },
      // (re)creates everything whose size depends on params: wall grid, simulation, dye (= LEDs)
      ensure(ctx) {
        const p = ctx.params;
        const ledW = Math.round(p.ledW);
        const ledH = Math.round(p.ledH);
        const gridW = Math.max(8, Math.round((GRID_ROWS * p.wallW) / p.wallH));
        const simH = Number(p.simRes) || 112;
        const simW = Math.max(8, Math.round((simH * ledW) / ledH));
        const key = `${ledW}x${ledH}:${gridW}:${simW}x${simH}`;
        if (this.r?.key === key) return this.r;
        this.destroyWall();
        const buffer = (bytes) => {
          const b = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
          owned.add(b);
          return b;
        };
        this.r = {
          key,
          gridW,
          cells: buffer(gridW * GRID_ROWS * 16),
          vcells: buffer(gridW * GRID_ROWS * 32),
          raw: makeTex(gridW, GRID_ROWS),
          wallSig: pair(gridW, GRID_ROWS),
          rawMotion: makeTex(gridW, GRID_ROWS),
          rawArm: makeTex(gridW, GRID_ROWS),
          motion: makeTex(gridW, GRID_ROWS),
          simW,
          simH,
          vel: pair(simW, simH),
          pres: pair(simW, simH),
          curl: makeTex(simW, simH),
          div: makeTex(simW, simH),
          ledW,
          ledH,
          dye: pair(ledW, ledH),
          dyeTmp: makeTex(ledW, ledH),
          stats: pair(1, 1),
        };
        return this.r;
      },
      // the room matrix and every visible person's joints (room m)
      writeSkeletons(ctx) {
        const p = ctx.params;
        const persons = ctx.persons;
        const room = persons.room;
        const m = room?.found ? room.matrix : manualRoom(p.camH, p.camTilt);
        const d = this.skel;
        d.fill(0);
        d.set(m, 0);
        for (const person of persons) {
          const s = person.slot;
          if (s < 1 || s > 16) continue;
          for (let j = 0; j < POINTS.length; j++) {
            const name = POINTS[j];
            const w = person.joints[name];
            if (!w) continue;
            d.set([...roomPoint(m, w), Math.max(0.01, person.confidence[name] ?? 1)], (SKEL_JOINTS + s * POINTS.length + j) * 4);
          }
          d.set([...person.color, 1], (SKEL_PERSONS + s) * 4);
        }
        device.queue.writeBuffer(skelBuf, 0, d);
      },
      destroyWall() {
        owned.forEach((t) => t.destroy());
        owned.clear();
        this.groups.clear();
        this.r = null;
      },
      destroy() {
        this.destroyWall();
        this.readback.destroy();
        camOwned.forEach((t) => t.destroy());
        camOwned.clear();
      },
    };
    ctx.track(S);
  },

  frame(ctx) {
    const { device, pipes, uni } = S;
    const p = ctx.params;
    const r = S.ensure(ctx);
    const dt = Math.min(Math.max(ctx.dt, 0.001), 1 / 20);
    const k = ctx.kinect;
    const fresh = k.fresh.persons && k.persons;
    // frames since the last result (normally 1): the optical flow measures over all of them
    let frameStep = 1;
    if (fresh) {
      S.lastPersons = ctx.time;
      if (S.lastSeq !== null) frameStep = Math.min(3, Math.max(1, k.persons.seq - S.lastSeq));
      S.lastSeq = k.persons.seq;
    }
    const motionOn = S.lastPersons >= 0 && ctx.time - S.lastPersons < 0.5;

    // the wall rectangle on the canvas (same as wallRect() in sim.wgsl), for the mouse
    let rect;
    if (Number(p.viewMode) === 1) rect = [0, 0, r.ledW, r.ledH];
    else {
      const s = Math.min(ctx.width / r.ledW, ctx.height / r.ledH);
      rect = [(ctx.width - r.ledW * s) / 2, (ctx.height - r.ledH * s) / 2, r.ledW * s, r.ledH * s];
    }
    // mouse in wall uv and wall uv per second, smoothed
    const m = S.mouse;
    const mx = (ctx.pointer.x - rect[0]) / rect[2];
    const my = (ctx.pointer.y - rect[1]) / rect[3];
    m.vx = m.vx * 0.5 + ((mx - m.x) / dt) * 0.5;
    m.vy = m.vy * 0.5 + ((my - m.y) / dt) * 0.5;
    m.x = mx;
    m.y = my;

    const tint = Number.parseInt(String(p.tint).slice(1), 16) || 0;
    const values = {
      ...p,
      simW: r.simW, simH: r.simH, dyeW: r.ledW, dyeH: r.ledH, gridW: r.gridW, gridH: GRID_ROWS,
      screenW: ctx.width, screenH: ctx.height,
      mouseX: m.x, mouseY: m.y, mouseDX: m.vx, mouseDY: m.vy, mouseDown: ctx.pointer.down ? 1 : 0,
      dt, time: ctx.time, xSign: ctx.xSign, motionOn: motionOn ? 1 : 0, frameStep, lambda: p.denoise * 0.001,
      colorMode: Number(p.colorMode) || 0, viewMode: Number(p.viewMode) || 0,
      showPeople: p.showPeople ? 1 : 0, showSkeleton: p.showSkeleton ? 1 : 0, showFlow: p.showFlow ? 1 : 0, balanceOn: p.balanceOn ? 1 : 0,
      tintR: ((tint >> 16) & 255) / 255, tintG: ((tint >> 8) & 255) / 255, tintB: (tint & 255) / 255,
    };
    FIELDS.forEach((f, i) => (uni[i] = Number(values[f]) || 0));
    device.queue.writeBuffer(S.uniformBuf, 0, uni);
    if (fresh) S.writeSkeletons(ctx);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    const run = (pipe, kind, a, b, out, c, size = out) => {
      pass.setPipeline(pipe);
      pass.setBindGroup(0, S.group(kind, a, b, out, c));
      pass.dispatchWorkgroups(Math.ceil(size.w / 8), Math.ceil(size.h / 8));
    };
    const sim = (pipe, a, b, out, c) => run(pipe, 'sim', a, b, out, c);
    const kinect = (pipe, out, size) => run(pipe, 'kinect', null, null, out, null, size);
    const cam = S.cam;

    // how full the wall is (from the last frame's dye): steers the balance of this frame
    sim(pipes.dyeStats, r.dye.read, r.stats.read, r.stats.write);
    r.stats.swap();

    // the people -> the wall, once per person tracking result (masks and skeletons of one frame)
    if (fresh) {
      // optical flow of the people's camera image, coarse to fine
      kinect(pipes.prep, cam.prep, DEPTH);
      sim(pipes.camSignal, cam.prep, cam.sig.read, cam.sig.write);
      cam.sig.swap();
      sim(pipes.down, cam.sig.read, cam.sig.read, cam.sig1);
      sim(pipes.down, cam.sig1, cam.sig1, cam.sig2);
      sim(pipes.lkCoarse, cam.sig2, cam.sig2, cam.flow2);
      sim(pipes.lkRefine, cam.sig1, cam.flow2, cam.flow1);
      sim(pipes.lkFinal, cam.sig.read, cam.flow1, cam.flow.write, cam.flow.read);
      cam.flow.swap();
      // wall image and 3D motion on the wall
      kinect(pipes.nearest, r.raw, DEPTH);
      kinect(pipes.project, r.raw, DEPTH);
      kinect(pipes.scene, r.raw, FLOW);
      kinect(pipes.collect, r.raw, r.raw);
      kinect(pipes.vcollect, r.raw, r.raw);
      sim(pipes.wallSignal, r.raw, r.wallSig.read, r.wallSig.write);
      r.wallSig.swap();
      sim(pipes.wallMotion, r.rawMotion, r.rawMotion, r.motion, r.rawArm);
    }

    // forces and dye from the motion
    sim(pipes.force, r.vel.read, r.motion, r.vel.write);
    r.vel.swap();
    sim(pipes.dye, r.dye.read, r.motion, r.dye.write, r.wallSig.read);
    r.dye.swap();

    // vorticity confinement
    sim(pipes.curl, r.vel.read, r.vel.read, r.curl);
    sim(pipes.vorticity, r.vel.read, r.curl, r.vel.write);
    r.vel.swap();

    // projection
    sim(pipes.divergence, r.vel.read, r.vel.read, r.div);
    sim(pipes.pressureFade, r.pres.read, r.pres.read, r.pres.write);
    r.pres.swap();
    const iters = Math.round(p.pressureIters);
    for (let i = 0; i < iters; i++) {
      sim(pipes.jacobi, r.pres.read, r.div, r.pres.write);
      r.pres.swap();
    }
    sim(pipes.gradient, r.vel.read, r.pres.read, r.vel.write);
    r.vel.swap();

    // advection; dye with MacCormack: forward estimate into tmp, then the correction against the old dye
    sim(pipes.advectVel, r.vel.read, r.vel.read, r.vel.write);
    r.vel.swap();
    sim(pipes.advect, r.vel.read, r.dye.read, r.dyeTmp);
    sim(pipes.maccormackDye, r.vel.read, r.dyeTmp, r.dye.write, r.dye.read);
    r.dye.swap();
    pass.end();

    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: S.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    rp.setPipeline(S.display);
    rp.setBindGroup(0, S.group('display', r.dye.read, r.motion, null, r.wallSig.read));
    rp.draw(3);
    rp.end();
    const read = !S.reading && ctx.time - S.lastRead > 0.5;
    if (read) enc.copyTextureToBuffer({ texture: r.stats.read.tex }, { buffer: S.readback, bytesPerRow: 256 }, [1, 1]);
    device.queue.submit([enc.finish()]);
    if (read) {
      S.reading = true;
      S.lastRead = ctx.time;
      const buf = S.readback;
      buf.mapAsync(GPUMapMode.READ).then(
        () => {
          const h = new Uint16Array(buf.getMappedRange(0, 8));
          [S.fill, S.gain] = [half(h[0]), half(h[1])];
          buf.unmap();
          S.reading = false;
        },
        () => (S.reading = false),
      );
    }

    const floor = ctx.persons.room?.found ? `Boden: Kinect ${ctx.persons.room.height.toFixed(2)} m hoch` : `kein Boden erkannt: Kinect ${p.camH} m (Regler)`;
    const bal = p.balanceOn ? ` · Füllung ${Math.round(S.fill * 100)} % · Ausgleich ×${(S.gain || 1).toFixed(2)}` : '';
    ctx.status = `${ctx.persons.length} Person(en) · ${floor}${bal}`;
  },

  dispose() {
    S = null;
  },
};
