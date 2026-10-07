// Fluid driven by optical flow: the Kinect signal (nearness, plus some IR) goes through a Lucas-Kanade
// optical flow on the GPU, and the motion field pushes a stable-fluids simulation and injects dye.
// Move in front of the sensor and you stir the fluid; dragging the mouse works too.
//
// Per Kinect frame: kinect.wgsl `prep` (nearness + IR, holes filled), sim.wgsl `signal` (-> 128x106), `flow`.
// Per render frame: force, dye, curl, vorticity, divergence, pressure (Jacobi), gradient,
// advection (dye: MacCormack), display.

import { checkedModule } from '/lib/shader-pass.js';
import COMMON from './common.wgsl?raw';
import KINECT from './kinect.wgsl?raw';
import SIM from './sim.wgsl?raw';

const FLOW_W = 128;
const FLOW_H = 106;
const U_FLOATS = 40; // struct Uni in common.wgsl
const MAX_DYE_ROWS = 1440;

let S = null; // everything setup() creates

export default {
  streams: ['depth', 'ir'],
  // The Kinect delivers 30 frames/s anyway, and the depth decoding shares the GPU: at 60 fps the
  // dye passes alone took most of an integrated GPU.
  maxFps: 30,

  params: {
    force: { value: 10, min: 0, max: 40, step: 0.5, label: 'Mitnahme', folder: 'Bewegung' },
    flowGain: { value: 1.8, min: 0.2, max: 5, step: 0.05, label: 'Verstärkung', folder: 'Bewegung' },
    threshold: { value: 0.15, min: 0, max: 1, step: 0.01, label: 'Schwelle (px)', folder: 'Bewegung' },
    coherence: { value: 0.5, min: 0, max: 0.95, step: 0.01, label: 'Richtungstreue', folder: 'Bewegung' },
    denoise: { value: 8, min: 0.1, max: 30, step: 0.1, label: 'Rauschfilter', folder: 'Bewegung' },
    flowSmooth: { value: 0.5, min: 0, max: 0.9, step: 0.01, label: 'Glättung', folder: 'Bewegung' },
    nearM: { value: 0.5, min: 0.3, max: 3, step: 0.05, label: 'Nah (m)', folder: 'Bewegung' },
    farM: { value: 4.0, min: 1, max: 8, step: 0.1, label: 'Fern (m)', folder: 'Bewegung' },
    irMix: { value: 0.3, min: 0, max: 1, step: 0.01, label: 'IR-Anteil', folder: 'Bewegung' },

    curl: { value: 20, min: 0, max: 80, step: 1, label: 'Wirbel', folder: 'Fluid' },
    velDiss: { value: 0.3, min: 0, max: 4, step: 0.05, label: 'Bremsen', folder: 'Fluid' },
    dyeDiss: { value: 0.5, min: 0, max: 4, step: 0.05, label: 'Verblassen', folder: 'Fluid' },
    fade: { value: 0.06, min: 0, max: 0.5, step: 0.01, label: 'Ausklingen', folder: 'Fluid' },
    pressureIters: { value: 24, min: 4, max: 60, step: 1, label: 'Druck-Iterationen', folder: 'Fluid' },
    pressureDecay: { value: 0.8, min: 0, max: 1, step: 0.01, label: 'Druck halten', folder: 'Fluid' },
    simRes: { value: 256, options: [128, 192, 256, 384], label: 'Auflösung Strömung', folder: 'Fluid' },
    dyeRes: { value: 720, options: { 540: 540, 720: 720, 1080: 1080, Bildschirm: 0 }, label: 'Auflösung Farbe', folder: 'Fluid' },

    colorMode: { value: 0, options: { Neon: 0, Regenbogen: 1, Tiefe: 2, Einfarbig: 3 }, label: 'Farben' },
    tint: { value: '#4fb4ff', label: 'Einfarbig' },
    hueSpeed: { value: 0.04, min: -0.5, max: 0.5, step: 0.01, label: 'Farbdrift' },
    dyeAmount: { value: 2, min: 0, max: 4, step: 0.05, label: 'Farbmenge' },
    exposure: { value: 1.8, min: 0.2, max: 5, step: 0.05, label: 'Helligkeit' },
    shading: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Relief' },
    silhouette: { value: 0, min: 0, max: 1, step: 0.01, label: 'Umriss' },
    splatRadius: { value: 0.05, min: 0.01, max: 0.2, step: 0.005, label: 'Maus-Radius' },
    showFlow: { value: false, label: 'Fluss zeigen' },
  },

  async setup(ctx) {
    const { device, context, format } = await ctx.webgpu();
    const gpu = ctx.kinect.gpu;
    const lines = COMMON.split('\n').length;
    const simModule = await checkedModule(device, `${COMMON}\n${SIM}`, 'flow-fluid sim.wgsl', lines);
    const kinectModule = await checkedModule(device, `${COMMON}\n${KINECT}`, 'flow-fluid kinect.wgsl', lines);

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
        { binding: 2, visibility: C, texture: { sampleType: 'float' } },
        { binding: 4, visibility: C, storageTexture: storage },
      ],
    });
    const displayLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: F, sampler: { type: 'filtering' } },
        { binding: 6, visibility: F, texture: { sampleType: 'float' } },
      ],
    });

    device.pushErrorScope('validation');
    const simPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [simLayout] });
    const compute = (entryPoint, module = simModule, layout = simPipelineLayout) =>
      device.createComputePipeline({ layout, compute: { module, entryPoint } });
    const pipes = {};
    const entries = ['signal', 'flow', 'force', 'dye', 'curl', 'vorticity', 'divergence', 'pressureFade', 'jacobi', 'gradient', 'advect', 'advectVel', 'maccormackDye'];
    for (const name of entries) pipes[name] = compute(name);
    pipes.prep = compute('prep', kinectModule, device.createPipelineLayout({ bindGroupLayouts: [kinectLayout] }));
    const display = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [displayLayout] }),
      vertex: { module: simModule, entryPoint: 'vs' },
      fragment: { module: simModule, entryPoint: 'display', targets: [{ format }] },
    });
    const err = await device.popErrorScope();
    if (err) throw new Error(`Pipeline: ${err.message}`);

    const uniformBuf = ctx.track(device.createBuffer({ size: U_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    let nextId = 0;
    const owned = new Set();
    const makeTex = (w, h) => {
      const tex = device.createTexture({
        size: [w, h],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
      owned.add(tex);
      return { tex, view: tex.createView(), id: nextId++, w, h };
    };
    const pair = (w, h) => ({
      read: makeTex(w, h),
      write: makeTex(w, h),
      swap() {
        [this.read, this.write] = [this.write, this.read];
      },
    });
    const destroyAll = (set) => set.forEach((t) => t.destroy());
    const depthView = gpu.depthTexture.createView();
    const irView = gpu.irTexture.createView();

    S = {
      device,
      context,
      pipes,
      display,
      uniformBuf,
      uni: new Float32Array(U_FLOATS),
      prep: makeTex(512, 424),
      sig: pair(FLOW_W, FLOW_H),
      flow: pair(FLOW_W, FLOW_H),
      sim: null,
      groups: new Map(),
      mouse: { x: 0, y: 0, vx: 0, vy: 0 },
      lastFresh: 0,
      lastIr: 0,
      newDepth: false,
      newIr: false,
      // bind group per (layout, inputs, output), cached; c is the third input (MacCormack)
      group(kind, a, b, out, c = a) {
        const key = `${kind}:${a.id}:${b?.id}:${out?.id}:${c.id}`;
        let g = this.groups.get(key);
        if (!g) {
          const buffer = { binding: 0, resource: { buffer: uniformBuf } };
          const entries = {
            kinect: () => [buffer, { binding: 1, resource: depthView }, { binding: 2, resource: irView }, { binding: 4, resource: out.view }],
            sim: () => [
              buffer,
              { binding: 1, resource: a.view },
              { binding: 2, resource: b.view },
              { binding: 3, resource: sampler },
              { binding: 4, resource: out.view },
              { binding: 5, resource: c.view },
            ],
            display: () => [buffer, { binding: 1, resource: a.view }, { binding: 2, resource: b.view }, { binding: 3, resource: sampler }, { binding: 6, resource: this.prep.view }],
          }[kind]();
          const layout = { kinect: kinectLayout, sim: simLayout, display: displayLayout }[kind];
          g = device.createBindGroup({ layout, entries });
          this.groups.set(key, g);
        }
        return g;
      },
      ensureSim(ctx) {
        const simH = Number(ctx.params.simRes) || 256;
        const dyeH = Number(ctx.params.dyeRes) || Math.min(ctx.height, MAX_DYE_ROWS);
        const aspect = ctx.width / Math.max(1, ctx.height);
        const sw = Math.max(8, Math.round(simH * aspect));
        const dw = Math.max(8, Math.round(dyeH * aspect));
        const s = this.sim;
        if (s && s.sw === sw && s.simH === simH && s.dw === dw && s.dyeH === dyeH) return s;
        if (s) {
          destroyAll(s.textures);
          for (const t of s.textures) owned.delete(t);
          this.groups.clear();
        }
        const before = new Set(owned);
        this.sim = {
          sw,
          simH,
          dw,
          dyeH,
          vel: pair(sw, simH),
          pres: pair(sw, simH),
          curl: makeTex(sw, simH),
          div: makeTex(sw, simH),
          dye: pair(dw, dyeH),
          dyeTmp: makeTex(dw, dyeH),
        };
        this.sim.textures = [...owned].filter((t) => !before.has(t));
        return this.sim;
      },
      destroy() {
        destroyAll(owned);
        owned.clear();
        this.groups.clear();
      },
    };
    ctx.track(S);
  },

  frame(ctx) {
    const { device, pipes, uni } = S;
    const p = ctx.params;
    const s = S.ensureSim(ctx);
    const dt = Math.min(Math.max(ctx.dt, 0.001), 1 / 30);

    // mouse velocity in canvas px per second, smoothed
    const m = S.mouse;
    m.vx = m.vx * 0.5 + ((ctx.pointer.x - m.x) / dt) * 0.5;
    m.vy = m.vy * 0.5 + ((ctx.pointer.y - m.y) / dt) * 0.5;
    m.x = ctx.pointer.x;
    m.y = ctx.pointer.y;

    const tint = Number.parseInt(String(p.tint).slice(1), 16) || 0;
    uni.set([
      s.sw, s.simH, s.dw, s.dyeH,
      ctx.width, ctx.height, m.x, m.y,
      m.vx, m.vy, ctx.pointer.down ? 1 : 0, dt,
      ctx.time, ctx.xSign, p.curl, p.velDiss,
      p.dyeDiss, p.force, p.dyeAmount, p.threshold,
      p.flowSmooth, p.nearM, p.farM, Number(p.colorMode) || 0,
      p.hueSpeed, p.silhouette, p.pressureDecay, p.shading,
      p.flowGain, p.irMix, p.showFlow ? 1 : 0, p.exposure,
      ((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255, p.splatRadius,
      p.denoise * 0.001, p.fade, p.coherence, 0,
    ]);
    device.queue.writeBuffer(S.uniformBuf, 0, uni);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    const run = (pipe, kind, a, b, out, c) => {
      pass.setPipeline(pipe);
      pass.setBindGroup(0, S.group(kind, a, b, out, c));
      pass.dispatchWorkgroups(Math.ceil(out.w / 8), Math.ceil(out.h / 8));
    };

    // optical flow, once per Kinect frame. Depth and IR arrive separately: wait until both are new
    // (or IR is missing), otherwise new depth would be compared with old IR.
    const k = ctx.kinect;
    if (k.fresh.depth) S.newDepth = true;
    if (k.fresh.ir) {
      S.newIr = true;
      S.lastIr = ctx.time;
    }
    if (k.depth && S.newDepth && (S.newIr || ctx.time - S.lastIr > 0.1)) {
      S.newDepth = false;
      S.newIr = false;
      run(pipes.prep, 'kinect', S.prep, null, S.prep);
      run(pipes.signal, 'sim', S.prep, S.sig.read, S.sig.write);
      S.sig.swap();
      run(pipes.flow, 'sim', S.sig.read, S.flow.read, S.flow.write);
      S.flow.swap();
      S.lastFresh = ctx.time;
    }

    // forces and dye from the motion
    run(pipes.force, 'sim', s.vel.read, S.flow.read, s.vel.write);
    s.vel.swap();
    run(pipes.dye, 'sim', s.dye.read, S.flow.read, s.dye.write);
    s.dye.swap();

    // vorticity confinement
    run(pipes.curl, 'sim', s.vel.read, s.vel.read, s.curl);
    run(pipes.vorticity, 'sim', s.vel.read, s.curl, s.vel.write);
    s.vel.swap();

    // projection
    run(pipes.divergence, 'sim', s.vel.read, s.vel.read, s.div);
    run(pipes.pressureFade, 'sim', s.pres.read, s.pres.read, s.pres.write);
    s.pres.swap();
    const iters = Math.round(p.pressureIters);
    for (let i = 0; i < iters; i++) {
      run(pipes.jacobi, 'sim', s.pres.read, s.div, s.pres.write);
      s.pres.swap();
    }
    run(pipes.gradient, 'sim', s.vel.read, s.pres.read, s.vel.write);
    s.vel.swap();

    // advection; dye with MacCormack: forward estimate into tmp, then the correction against the old dye
    run(pipes.advectVel, 'sim', s.vel.read, s.vel.read, s.vel.write);
    s.vel.swap();
    run(pipes.advect, 'sim', s.vel.read, s.dye.read, s.dyeTmp);
    run(pipes.maccormackDye, 'sim', s.vel.read, s.dyeTmp, s.dye.write, s.dye.read);
    s.dye.swap();
    pass.end();

    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: S.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    rp.setPipeline(S.display);
    rp.setBindGroup(0, S.group('display', s.dye.read, S.flow.read));
    rp.draw(3);
    rp.end();
    device.queue.submit([enc.finish()]);

    const age = ctx.time - S.lastFresh;
    ctx.status = !k.depth ? 'warte auf Kinect …' : age < 0.5 ? `Strömung ${s.sw}×${s.simH} · Farbe ${s.dw}×${s.dyeH}` : 'keine neuen Kinect-Bilder';
  },

  dispose() {
    S = null;
  },
};
