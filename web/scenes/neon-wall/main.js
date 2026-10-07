// Fluid on an LED wall (6 m x 2 m, 1008 x 336 LEDs), stirred by the people in front of it.
// Motion is measured in 3D: the optical flow of the camera image (pixels) is turned into meters per
// second with the depth, plus the change in depth, and every motion sample is put at its real place
// on the wall. Where a person stands and how fast they move counts in meters; standing closer to the
// sensor gives no more influence. Dye is colored by distance by default. Dragging the mouse works too.
//
// Per Kinect frame (camera.wgsl, kinect.wgsl, sim.wgsl):
//   prep -> camSignal -> down, down -> lkCoarse -> lkRefine -> lkFinal   optical flow, 3 levels
//   nearest, project, collect                                           wall image (front surface)
//   scene, vcollect                                                     3D motion -> wall
//   wallSignal, wallMotion                                              smoothing on the wall
// Per render frame: force, dye, curl, vorticity, divergence, pressure (Jacobi), gradient,
// advection (dye: MacCormack), display.

import { checkedModule } from '/lib/shader-pass.js';
import COMMON from './common.wgsl?raw';
import KINECT from './kinect.wgsl?raw';
import CAMERA from './camera.wgsl?raw';
import SIM from './sim.wgsl?raw';

// the uniforms, all f32; struct Uni in WGSL is generated from this list
const FIELDS = [
  'simW', 'simH', 'dyeW', 'dyeH', 'gridW', 'gridH', 'screenW', 'screenH',
  'mouseX', 'mouseY', 'mouseDX', 'mouseDY', 'mouseDown', 'dt', 'time', 'xSign',
  'wallW', 'wallH', 'wallBottom', 'camX', 'camH', 'camTilt', 'zoneNear', 'zoneFar', 'floorCut',
  'threshold', 'coherence', 'flowSmooth', 'wallSmooth', 'flowGain', 'force', 'lambda', 'irMix',
  'curl', 'velDiss', 'dyeDiss', 'fade', 'pressureDecay',
  'colorMode', 'hueSpeed', 'dyeAmount', 'exposure', 'shading', 'splatRadius', 'tintR', 'tintG', 'tintB',
  'showPeople', 'showFlow', 'viewMode',
];
const STRUCT = `struct Uni {\n${FIELDS.map((f) => `  ${f}: f32,`).join('\n')}\n};\n`;
const DEPTH = { w: 512, h: 424 };
const FLOW = { w: 128, h: 106 }; // optical flow, finest level; then 64x53 and 32x27
const GRID_ROWS = 64; // wall cells: 64 rows = about 3 cm per cell on a 2 m wall

let S = null; // everything setup() creates

export default {
  streams: ['depth', 'ir'],
  pixelRatio: 1, // canvas pixels = screen pixels, so "LED pixelgenau" really is one LED per pixel
  // the Kinect delivers 30 frames/s anyway, and the depth decoding shares the GPU
  maxFps: 30,

  params: {
    viewMode: { value: 0, options: { Vorschau: 0, 'LED pixelgenau': 1 }, label: 'Ansicht', folder: 'Wand' },
    showPeople: { value: false, label: 'Personen + 1-m-Raster', folder: 'Wand' },
    ledW: { value: 1008, min: 64, max: 4096, step: 1, label: 'LEDs breit', folder: 'Wand' },
    ledH: { value: 336, min: 32, max: 2048, step: 1, label: 'LEDs hoch', folder: 'Wand' },
    wallW: { value: 6, min: 1, max: 20, step: 0.1, label: 'Wand breit (m)', folder: 'Wand' },
    wallH: { value: 2, min: 0.5, max: 8, step: 0.1, label: 'Wand hoch (m)', folder: 'Wand' },
    wallBottom: { value: 0, min: 0, max: 3, step: 0.05, label: 'Wand Unterkante (m)', folder: 'Wand' },
    camX: { value: 0, min: -10, max: 10, step: 0.05, label: 'Kinect seitlich (m)', folder: 'Wand' },
    camH: { value: 0.8, min: 0, max: 4, step: 0.05, label: 'Kinect Höhe (m)', folder: 'Wand' },
    camTilt: { value: 0, min: -45, max: 45, step: 0.5, label: 'Kinect Neigung (°, + = runter)', folder: 'Wand' },
    zoneNear: { value: 1, min: 0.3, max: 4, step: 0.05, label: 'Zone ab (m)', folder: 'Wand' },
    zoneFar: { value: 4.5, min: 1, max: 8, step: 0.1, label: 'Zone bis (m)', folder: 'Wand' },
    floorCut: { value: 0.1, min: 0, max: 1, step: 0.01, label: 'Boden ignorieren bis (m)', folder: 'Wand' },

    force: { value: 10, min: 0, max: 40, step: 0.5, label: 'Mitnahme', folder: 'Bewegung' },
    flowGain: { value: 1.5, min: 0.2, max: 5, step: 0.05, label: 'Verstärkung', folder: 'Bewegung' },
    threshold: { value: 0.3, min: 0, max: 3, step: 0.05, label: 'Schwelle (m/s)', folder: 'Bewegung' },
    coherence: { value: 0.5, min: 0, max: 0.95, step: 0.01, label: 'Richtungstreue', folder: 'Bewegung' },
    denoise: { value: 8, min: 0.1, max: 30, step: 0.1, label: 'Rauschfilter', folder: 'Bewegung' },
    flowSmooth: { value: 0.5, min: 0, max: 0.9, step: 0.01, label: 'Glättung', folder: 'Bewegung' },
    wallSmooth: { value: 0.5, min: 0, max: 0.9, step: 0.01, label: 'Wandbild glätten', folder: 'Bewegung' },
    irMix: { value: 0.3, min: 0, max: 1, step: 0.01, label: 'IR-Anteil', folder: 'Bewegung' },

    curl: { value: 20, min: 0, max: 80, step: 1, label: 'Wirbel', folder: 'Fluid' },
    velDiss: { value: 0.3, min: 0, max: 4, step: 0.05, label: 'Bremsen', folder: 'Fluid' },
    dyeDiss: { value: 0.5, min: 0, max: 4, step: 0.05, label: 'Verblassen', folder: 'Fluid' },
    fade: { value: 0.06, min: 0, max: 0.5, step: 0.01, label: 'Ausklingen', folder: 'Fluid' },
    pressureIters: { value: 24, min: 4, max: 60, step: 1, label: 'Druck-Iterationen', folder: 'Fluid' },
    pressureDecay: { value: 0.8, min: 0, max: 1, step: 0.01, label: 'Druck halten', folder: 'Fluid' },
    simRes: { value: 112, options: [84, 112, 168], label: 'Auflösung Strömung', folder: 'Fluid' },

    colorMode: { value: 0, options: { Tiefe: 0, Neon: 1, Regenbogen: 2, Einfarbig: 3 }, label: 'Farben' },
    tint: { value: '#4fb4ff', label: 'Einfarbig' },
    hueSpeed: { value: 0.04, min: -0.5, max: 0.5, step: 0.01, label: 'Farbdrift' },
    dyeAmount: { value: 2, min: 0, max: 4, step: 0.05, label: 'Farbmenge' },
    exposure: { value: 1.8, min: 0.2, max: 5, step: 0.05, label: 'Helligkeit' },
    shading: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Relief' },
    splatRadius: { value: 0.03, min: 0.005, max: 0.2, step: 0.005, label: 'Maus-Radius' },
    showFlow: { value: false, label: 'Fluss zeigen' },
  },

  async setup(ctx) {
    const { device, context, format } = await ctx.webgpu();
    const gpu = ctx.kinect.gpu;
    const head = `${STRUCT}${COMMON}`;
    const lines = head.split('\n').length;
    const simModule = await checkedModule(device, `${head}\n${CAMERA}\n${SIM}`, 'neon-wall camera.wgsl + sim.wgsl', lines);
    const kinectModule = await checkedModule(device, `${head}\n${KINECT}`, 'neon-wall kinect.wgsl', lines);

    const C = GPUShaderStage.COMPUTE;
    const F = GPUShaderStage.FRAGMENT;
    const storage = { access: 'write-only', format: 'rgba16float' };
    const simLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, texture: { sampleType: 'float' } },
        { binding: 2, visibility: C, texture: { sampleType: 'float' } },
        { binding: 3, visibility: C, sampler: { type: 'filtering' } },
        { binding: 4, visibility: C, storageTexture: storage },
        { binding: 5, visibility: C, texture: { sampleType: 'float' } },
      ],
    });
    const kinectLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: C, texture: { sampleType: 'float' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
        { binding: 5, visibility: C, storageTexture: storage },
        { binding: 6, visibility: C, texture: { sampleType: 'float' } },
        { binding: 7, visibility: C, texture: { sampleType: 'float' } },
        { binding: 8, visibility: C, buffer: { type: 'storage' } },
        { binding: 9, visibility: C, storageTexture: storage },
      ],
    });
    const displayLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: F, sampler: { type: 'filtering' } },
        { binding: 5, visibility: F, texture: { sampleType: 'float' } },
      ],
    });

    device.pushErrorScope('validation');
    const simPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [simLayout] });
    const kinectPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [kinectLayout] });
    const pipes = {};
    const simEntries = [
      'camSignal', 'down', 'lkCoarse', 'lkRefine', 'lkFinal', 'wallSignal', 'wallMotion',
      'force', 'dye', 'curl', 'vorticity', 'divergence', 'pressureFade', 'jacobi', 'gradient', 'advectVel', 'advect', 'maccormackDye',
    ];
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
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const depthView = gpu.depthTexture.createView();
    const lutView = gpu.lutTexture.createView();
    const irView = gpu.irTexture.createView();

    let nextId = 0;
    const camOwned = new Set(); // fixed size, lives as long as the scene
    const wallOwned = new Set(); // size depends on params, see ensure()
    const makeTex = (set, w, h) => {
      const tex = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
      set.add(tex);
      return { tex, view: tex.createView(), id: nextId++, w, h };
    };
    const pair = (set, w, h) => ({
      read: makeTex(set, w, h),
      write: makeTex(set, w, h),
      swap() {
        [this.read, this.write] = [this.write, this.read];
      },
    });
    const half = (n) => Math.ceil(n / 2);
    const cam = {
      prep: makeTex(camOwned, DEPTH.w, DEPTH.h),
      sig: pair(camOwned, FLOW.w, FLOW.h),
      sig1: makeTex(camOwned, half(FLOW.w), half(FLOW.h)),
      sig2: makeTex(camOwned, half(half(FLOW.w)), half(half(FLOW.h))),
      flow2: makeTex(camOwned, half(half(FLOW.w)), half(half(FLOW.h))),
      flow1: makeTex(camOwned, half(FLOW.w), half(FLOW.h)),
      flow: pair(camOwned, FLOW.w, FLOW.h),
    };

    S = {
      device,
      context,
      pipes,
      display,
      uniformBuf,
      uni: new Float32Array(uniformBuf.size / 4),
      cam,
      r: null, // wall resources, see ensure()
      groups: new Map(),
      mouse: { x: 0, y: 0, vx: 0, vy: 0 },
      lastFresh: 0,
      lastIr: 0,
      newDepth: false,
      newIr: false,
      // bind group per (layout, inputs, output), cached. sim: a, b, c sampled, out storage.
      // kinect: a = camera flow, b = camera signal, out and c = storage outputs.
      group(kind, a, b, out, c = a) {
        const key = `${kind}:${a?.id}:${b?.id}:${out?.id}:${c?.id}`;
        let g = this.groups.get(key);
        if (!g) {
          const buffer = { binding: 0, resource: { buffer: uniformBuf } };
          const entries = {
            kinect: () => [
              buffer,
              { binding: 1, resource: depthView },
              { binding: 2, resource: lutView },
              { binding: 3, resource: irView },
              { binding: 4, resource: { buffer: this.r.cells } },
              { binding: 5, resource: out.view },
              { binding: 6, resource: a.view },
              { binding: 7, resource: b.view },
              { binding: 8, resource: { buffer: this.r.vcells } },
              { binding: 9, resource: c.view },
            ],
            sim: () => [
              buffer,
              { binding: 1, resource: a.view },
              { binding: 2, resource: b.view },
              { binding: 3, resource: sampler },
              { binding: 4, resource: out.view },
              { binding: 5, resource: c.view },
            ],
            display: () => [buffer, { binding: 1, resource: a.view }, { binding: 2, resource: b.view }, { binding: 3, resource: sampler }, { binding: 5, resource: c.view }],
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
          wallOwned.add(b);
          return b;
        };
        this.r = {
          key,
          gridW,
          cells: buffer(gridW * GRID_ROWS * 16),
          vcells: buffer(gridW * GRID_ROWS * 16),
          raw: makeTex(wallOwned, gridW, GRID_ROWS),
          wallSig: pair(wallOwned, gridW, GRID_ROWS),
          rawMotion: makeTex(wallOwned, gridW, GRID_ROWS),
          motion: makeTex(wallOwned, gridW, GRID_ROWS),
          simW,
          simH,
          vel: pair(wallOwned, simW, simH),
          pres: pair(wallOwned, simW, simH),
          curl: makeTex(wallOwned, simW, simH),
          div: makeTex(wallOwned, simW, simH),
          ledW,
          ledH,
          dye: pair(wallOwned, ledW, ledH),
          dyeTmp: makeTex(wallOwned, ledW, ledH),
        };
        return this.r;
      },
      destroyWall() {
        wallOwned.forEach((t) => t.destroy());
        wallOwned.clear();
        this.groups.clear();
        this.r = null;
      },
      destroy() {
        this.destroyWall();
        camOwned.forEach((t) => t.destroy());
        camOwned.clear();
      },
    };
    ctx.track(S);
  },

  frame(ctx) {
    const { device, pipes, uni, cam } = S;
    const p = ctx.params;
    const r = S.ensure(ctx);
    const dt = Math.min(Math.max(ctx.dt, 0.001), 1 / 20);

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
      dt, time: ctx.time, xSign: ctx.xSign,
      lambda: p.denoise * 0.001,
      colorMode: Number(p.colorMode) || 0, viewMode: Number(p.viewMode) || 0,
      showPeople: p.showPeople ? 1 : 0, showFlow: p.showFlow ? 1 : 0,
      tintR: ((tint >> 16) & 255) / 255, tintG: ((tint >> 8) & 255) / 255, tintB: (tint & 255) / 255,
    };
    FIELDS.forEach((f, i) => (uni[i] = Number(values[f]) || 0));
    device.queue.writeBuffer(S.uniformBuf, 0, uni);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    const run = (pipe, kind, a, b, out, c, size = out) => {
      pass.setPipeline(pipe);
      pass.setBindGroup(0, S.group(kind, a, b, out, c));
      pass.dispatchWorkgroups(Math.ceil(size.w / 8), Math.ceil(size.h / 8));
    };
    const sim = (pipe, a, b, out, c) => run(pipe, 'sim', a, b, out, c);
    const kinect = (pipe, out, size) => run(pipe, 'kinect', cam.flow.read, cam.sig.read, out, r.rawMotion, size);

    // once per Kinect frame. Depth and IR arrive separately: wait until both are new (or IR is
    // missing), otherwise new depth would meet old IR.
    const k = ctx.kinect;
    if (k.fresh.depth) S.newDepth = true;
    if (k.fresh.ir) {
      S.newIr = true;
      S.lastIr = ctx.time;
    }
    if (k.depth && S.newDepth && (S.newIr || ctx.time - S.lastIr > 0.1)) {
      S.newDepth = false;
      S.newIr = false;
      // optical flow of the camera image, coarse to fine
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
      sim(pipes.wallMotion, r.rawMotion, r.rawMotion, r.motion);
      S.lastFresh = ctx.time;
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
    device.queue.submit([enc.finish()]);

    const age = ctx.time - S.lastFresh;
    ctx.status = !k.depth ? 'warte auf Kinect …' : age < 0.5 ? `Wand ${r.ledW}×${r.ledH} LEDs · Raster ${r.gridW}×${GRID_ROWS}` : 'keine neuen Kinect-Bilder';
  },

  dispose() {
    S = null;
  },
};
