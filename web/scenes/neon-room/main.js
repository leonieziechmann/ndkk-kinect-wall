// Neon-Raum: only the people from the Kinect, as lit point clouds in a minimal virtual room — a dark
// glossy floor with a neon grid fading into the fog, a glowing horizon, a ring of light in their
// color under every person, the field of view of the sensor on the floor, their reflection.
//
// Built on the person tracking (streams: ['persons'], /lib/persons.js): the tracker in the runtime
// delivers the depth of the person pixels only, their slot per pixel, the list of persons and the
// floor plane. The floor of the room is the real floor (estimated from the background or the feet);
// without one the sensor counts as level and the floor goes under the lowest person.
// Raw WebGPU: points (additive, rgba16f) -> mirrored points (half res, blurred) -> glow (quarter
// res) -> one fullscreen pass that draws the room and puts everything together.
// Keys: drag/wheel/space/r as in every 3D scene.

import { checkedModule } from '/lib/shader-pass.js';
import { PERSON_COLORS, MAX_PERSONS, roomFrame, toWorld } from '/lib/persons.js';
import POINTS_WGSL from './points.wgsl?raw';
import ROOM_WGSL from './room.wgsl?raw';
import GLOW_WGSL from './glow.wgsl?raw';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hex = (h) => {
  const v = Number.parseInt(String(h).slice(1), 16) || 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

// ---------- matrices (column-major, as WGSL mat4x4f) ----------

function lookAt(eye, target) {
  const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const lf = Math.hypot(...f) || 1;
  for (let i = 0; i < 3; i++) f[i] /= lf;
  // left-handed like ctx.camera: rows right, up, forward
  let r = [f[2], 0, -f[0]];
  const lr = Math.hypot(...r) || 1;
  r = r.map((x) => x / lr);
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  const d = (a) => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  return new Float32Array([r[0], u[0], f[0], 0, r[1], u[1], f[1], 0, r[2], u[2], f[2], 0, -d(r), -d(u), -d(f), 1]);
}

function perspective(fovYDeg, aspect, near, far) {
  const sy = 1 / Math.tan((fovYDeg * DEG) / 2);
  const sx = sy / aspect;
  const A = far / (far - near);
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, A, 1, 0, 0, -near * A, 0]);
}

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function invert(m) {
  const inv = new Float32Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06 || 1e-12;
  const v = [
    a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09, a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03,
    a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07, a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01,
    a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06, a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00,
    a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06, a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00,
  ];
  for (let i = 0; i < 16; i++) inv[i] = v[i] / det;
  return inv;
}

/** Kinect camera frame (mm, x right, y down) -> room (m): the room matrix after the world flip. */
function kinectToRoom(M, xSign) {
  const K = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    K[r] = M[r] * xSign * 0.001;
    K[4 + r] = -M[4 + r] * 0.001;
    K[8 + r] = M[8 + r] * 0.001;
    K[12 + r] = M[12 + r];
  }
  return K;
}

function project(vp, p, w, h) {
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (cw < 0.05) return null;
  return [((x / cw) * 0.5 + 0.5) * w, (0.5 - (y / cw) * 0.5) * h];
}

// ---------- state ----------

let gpu = null;
let res = null; // pipelines, buffers, bind groups
let targets = null; // size-dependent textures
let tags = null;
const tagEls = new Map();
const rings = new Map(); // person id -> { x, z, alpha, slot, seen }
const view = { stage: [0, 2.6], fallback: null, eye: [0, 1, 0] };
const pointData = new ArrayBuffer(512);
const pf = new Float32Array(pointData);
const roomData = new ArrayBuffer(768);
const rf = new Float32Array(roomData);
const colorArray = new Float32Array(17 * 4);
PERSON_COLORS.forEach((c, i) => colorArray.set([...hex(c), 1], i * 4));

function ensureTargets(ctx) {
  const { device } = gpu;
  const w = ctx.width;
  const h = ctx.height;
  if (targets && targets.w === w && targets.h === h) return targets;
  targets?.textures.forEach((t) => t.destroy());
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  const tex = (tw, th) => device.createTexture({ size: [Math.max(1, tw), Math.max(1, th)], format: 'rgba16float', usage });
  const acc = tex(w, h);
  const hw = Math.ceil(w / 2);
  const hh = Math.ceil(h / 2);
  const refl = tex(hw, hh);
  const refl2 = tex(hw, hh);
  const q1 = tex(Math.ceil(w / 4), Math.ceil(h / 4));
  const q2 = tex(Math.ceil(w / 4), Math.ceil(h / 4));
  const s = res.sampler;
  const bg = (pipeline, entries) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
  const glowGroup = (src, buf) => bg(res.blur, [{ binding: 0, resource: src.createView() }, { binding: 1, resource: s }, { binding: 2, resource: { buffer: buf } }]);
  targets = {
    w,
    h,
    hw,
    hh,
    textures: [acc, refl, refl2, q1, q2],
    accView: acc.createView(),
    reflView: refl.createView(),
    refl2View: refl2.createView(),
    q1View: q1.createView(),
    q2View: q2.createView(),
    down: bg(res.down, [{ binding: 0, resource: acc.createView() }, { binding: 1, resource: s }, { binding: 2, resource: { buffer: res.dirBufs.down } }]),
    glowH: glowGroup(q1, res.dirBufs.h),
    glowV: glowGroup(q2, res.dirBufs.v),
    reflH: glowGroup(refl, res.dirBufs.h),
    reflV: glowGroup(refl2, res.dirBufs.v),
    room: bg(res.room, [
      { binding: 0, resource: { buffer: res.roomBuf } },
      { binding: 1, resource: acc.createView() },
      { binding: 2, resource: q1.createView() },
      { binding: 3, resource: refl.createView() },
      { binding: 4, resource: s },
    ]),
  };
  return targets;
}

// ---------- per frame: floor, stage, rings, camera ----------

function updateRoom(ctx) {
  const p = ctx.kinect.persons;
  const list = p?.list ?? [];
  const floor = p?.floor ?? null;
  if (!floor) {
    // no floor in view: the sensor counts as level, the floor goes under the lowest person
    let lowest = 0;
    for (const q of list) if (q.visible) lowest = Math.max(lowest, q.ground[1] / 1000);
    if (lowest > 0.15) view.fallback = view.fallback ? view.fallback + 0.04 * (lowest - view.fallback) : lowest;
  }
  const frame = roomFrame(floor, ctx.xSign, view.fallback ?? ctx.params.sensorHeight);
  const now = ctx.time;
  // rings: fade in and out, follow the person
  let cx = 0;
  let cz = 0;
  let n = 0;
  for (const q of list) {
    const g = frame.apply(toWorld(q.ground, ctx.xSign));
    let r = rings.get(q.id);
    if (!r) {
      r = { x: g[0], z: g[2], alpha: 0, slot: q.slot, seen: now };
      rings.set(q.id, r);
    }
    r.x += 0.5 * (g[0] - r.x);
    r.z += 0.5 * (g[2] - r.z);
    r.slot = q.slot;
    if (q.visible) r.seen = now;
    if (q.visible) {
      cx += g[0];
      cz += g[2];
      n++;
    }
  }
  for (const [id, r] of rings) {
    const alive = now - r.seen < 0.05 && list.some((q) => q.id === id);
    r.alpha = clamp(r.alpha + (alive ? ctx.dt / 0.35 : -ctx.dt / 0.7), 0, 1);
    if (r.alpha <= 0 && !alive) rings.delete(id);
  }
  // the camera looks at the people (or at the middle of the field of view)
  const target = n ? [cx / n, cz / n] : [0, 2.6];
  const k = Math.min(1, ctx.dt * (n ? 1.2 : 0.4));
  view.stage[0] += k * (target[0] - view.stage[0]);
  view.stage[1] += k * (target[1] - view.stage[1]);
  return frame;
}

function cameraMatrices(ctx) {
  const P = ctx.params;
  const cam = ctx.camera; // standard interaction: drag, wheel, space, r
  const [yawDeg, pitchDeg] = cam.angles(performance.now());
  const yaw = yawDeg * DEG;
  const pitch = clamp(pitchDeg, -3, 65) * DEG;
  const dist = (P.distance * cam.zoom) / 1.6;
  const target = [view.stage[0], P.lookHeight, view.stage[1]];
  const eye = [
    target[0] + dist * Math.sin(yaw) * Math.cos(pitch),
    Math.max(0.12, target[1] + dist * Math.sin(pitch)),
    target[2] - dist * Math.cos(yaw) * Math.cos(pitch),
  ];
  const aspect = ctx.width / Math.max(1, ctx.height);
  const viewM = lookAt(eye, target);
  const proj = perspective(P.fov, aspect, 0.05, 400);
  const vp = mul(proj, viewM);
  view.eye = eye;
  return { vp, inv: invert(vp), eye, focalPx: ctx.height / 2 / Math.tan((P.fov * DEG) / 2) };
}

function updateTags(ctx, vp, frame) {
  const list = ctx.params.labels ? (ctx.kinect.persons?.list ?? []) : [];
  const seen = new Set();
  for (const q of list) {
    if (!q.visible) continue;
    const head = frame.apply(toWorld(q.head, ctx.xSign));
    const s = project(vp, [head[0], head[1] + 0.28, head[2]], ctx.width, ctx.height);
    if (!s) continue;
    seen.add(q.id);
    let el = tagEls.get(q.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'nr-tag';
      el.innerHTML = '<b></b><span></span>';
      tags.append(el);
      tagEls.set(q.id, el);
    }
    el.style.transform = `translate(${(s[0] / ctx.pixelRatio).toFixed(1)}px, ${(s[1] / ctx.pixelRatio).toFixed(1)}px) translate(-50%, -100%)`;
    el.style.color = PERSON_COLORS[q.slot];
    el.firstChild.textContent = String(q.id).padStart(2, '0');
    el.lastChild.textContent = `${q.height.toFixed(2).replace('.', ',')} m`;
  }
  for (const [id, el] of tagEls) {
    if (!seen.has(id)) {
      el.remove();
      tagEls.delete(id);
    }
  }
}

export default {
  streams: (p) => (p.irDetail > 0 ? ['persons', 'ir'] : ['persons']),
  maxWidth: 2560,

  params: {
    dotFill: { value: 0.62, min: 0.2, max: 1.4, step: 0.01, label: 'Punktgröße', folder: 'Personen' },
    gain: { value: 1.6, min: 0.3, max: 4, step: 0.05, label: 'Helligkeit', folder: 'Personen' },
    glow: { value: 0.55, min: 0, max: 2, step: 0.01, label: 'Glow', folder: 'Personen' },
    rim: { value: 0.9, min: 0, max: 2, step: 0.01, label: 'Randlicht', folder: 'Personen' },
    whiteMix: { value: 0.25, min: 0, max: 1, step: 0.01, label: 'Weiß im Licht', folder: 'Personen' },
    irDetail: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'IR-Details', folder: 'Personen' },
    scan: { value: true, label: 'Scan-Streifen', folder: 'Personen' },
    labels: { value: true, label: 'ID und Größe', folder: 'Personen' },
    reflection: { value: 0.45, min: 0, max: 1.5, step: 0.01, label: 'Spiegelung', folder: 'Raum' },
    grid: { value: 0.55, min: 0, max: 1.5, step: 0.01, label: 'Gitter', folder: 'Raum' },
    gridSize: { value: 0.5, min: 0.1, max: 2, step: 0.05, label: 'Gitterweite (m)', folder: 'Raum' },
    rings: { value: 1, min: 0, max: 2, step: 0.01, label: 'Ringe', folder: 'Raum' },
    fovLines: { value: 0.7, min: 0, max: 2, step: 0.01, label: 'Sichtfeld der Kinect', folder: 'Raum' },
    horizon: { value: 0.75, min: 0, max: 2, step: 0.01, label: 'Horizont', folder: 'Raum' },
    gridColor: { value: '#1ad8ff', label: 'Gitterfarbe', folder: 'Raum' },
    horizonColor: { value: '#7a3cff', label: 'Horizontfarbe', folder: 'Raum' },
    skyColor: { value: '#020309', label: 'Himmel', folder: 'Raum' },
    floorColor: { value: '#03050b', label: 'Boden', folder: 'Raum' },
    distance: { value: 4.2, min: 1.5, max: 10, step: 0.05, label: 'Abstand (m)', folder: 'Kamera' },
    lookHeight: { value: 1.0, min: 0.2, max: 2, step: 0.01, label: 'Blickhöhe (m)', folder: 'Kamera' },
    fov: { value: 42, min: 20, max: 80, step: 1, label: 'Bildwinkel (°)', folder: 'Kamera' },
    sensorHeight: { value: 1.0, min: 0.2, max: 3, step: 0.01, label: 'Kinect-Höhe ohne Boden (m)', folder: 'Kamera' },
  },

  async setup(ctx) {
    gpu = await ctx.webgpu();
    const { device, format } = gpu;
    const kg = ctx.kinect.gpu;
    const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const pointBufs = [0, 1].map(() => ctx.track(device.createBuffer({ size: 512, usage: UNIFORM })));
    const roomBuf = ctx.track(device.createBuffer({ size: 768, usage: UNIFORM }));
    const dirBuf = (x, y, z) => {
      const b = ctx.track(device.createBuffer({ size: 16, usage: UNIFORM }));
      device.queue.writeBuffer(b, 0, new Float32Array([x, y, z, 0]));
      return b;
    };
    const dirBufs = { down: dirBuf(0, 0, 4), h: dirBuf(1.5, 0, 1), v: dirBuf(0, 1.5, 1) };
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const additive = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };

    const pointsModule = await checkedModule(device, POINTS_WGSL, 'neon-room points.wgsl');
    const points = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: pointsModule, entryPoint: 'vs' },
      fragment: { module: pointsModule, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });
    const glowModule = await checkedModule(device, GLOW_WGSL, 'neon-room glow.wgsl');
    const full = (module, entryPoint, targetFormat) =>
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vsFull' },
        fragment: { module, entryPoint, targets: [{ format: targetFormat }] },
        primitive: { topology: 'triangle-list' },
      });
    const roomModule = await checkedModule(device, ROOM_WGSL, 'neon-room room.wgsl');
    const pointsGroup = (buf) =>
      device.createBindGroup({
        layout: points.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: { buffer: kg.personIndexBuffer } },
          { binding: 2, resource: { buffer: kg.personDepthBuffer } },
          { binding: 3, resource: { buffer: kg.personLabelBuffer } },
          { binding: 4, resource: { buffer: kg.lutBuffer } },
          { binding: 5, resource: { buffer: kg.irBuffer } },
        ],
      });
    res = {
      pointBufs,
      roomBuf,
      dirBufs,
      sampler,
      points,
      down: full(glowModule, 'fsDown', 'rgba16float'),
      blur: full(glowModule, 'fsBlur', 'rgba16float'),
      room: full(roomModule, 'fsRoom', format),
      groups: pointBufs.map(pointsGroup),
    };
    targets = null;

    tags = document.createElement('div');
    tags.className = 'nr-tags';
    const style = document.createElement('style');
    style.textContent = `
      .nr-tags { position: absolute; inset: 0; overflow: hidden; }
      .nr-tag { position: absolute; left: 0; top: 0; display: flex; gap: 8px; align-items: baseline;
        padding: 2px 9px 3px; border-left: 2px solid currentColor; background: rgba(2, 4, 10, 0.55);
        font: 500 13px/1.25 ui-monospace, 'Cascadia Mono', Consolas, monospace; letter-spacing: 0.08em;
        white-space: nowrap; text-shadow: 0 0 10px currentColor; }
      .nr-tag b { font-weight: 700; font-size: 15px; }
      .nr-tag span { color: #cfe8ff; opacity: 0.85; text-shadow: none; }`;
    ctx.dom.append(style, tags);
  },

  frame(ctx) {
    const { device, context } = gpu;
    const P = ctx.params;
    const t = ensureTargets(ctx);
    const persons = ctx.kinect.persons;
    const count = persons?.indices.length ?? 0;
    const frame = updateRoom(ctx);
    const cam = cameraMatrices(ctx);
    const K = kinectToRoom(frame.matrix, ctx.xSign);
    const fx = ctx.kinect.params?.fx ?? 365.5;
    const scanH = P.scan ? ((ctx.time * 0.42) % 3.2) - 0.4 : -1;
    // key light from above, slightly from the front (the side of the sensor) and the left
    const light = [-0.35, 0.8, -0.48];
    const ll = Math.hypot(...light);

    for (const mirror of [0, 1]) {
      pf.set(cam.vp, 0);
      pf.set(K, 16);
      pf.set([...cam.eye, ctx.time], 32);
      const w = mirror ? t.hw : t.w;
      const h = mirror ? t.hh : t.h;
      pf.set([w, h, 1 / w, 1 / h], 36);
      pf.set([P.dotFill * (mirror ? 1.3 : 1), fx, cam.focalPx * (mirror ? 0.5 : 1), mirror], 40);
      pf.set([P.gain, P.irDetail, scanH, 0.06], 44);
      pf.set([P.reflection, 2, P.whiteMix, P.rim], 48);
      pf.set([light[0] / ll, light[1] / ll, light[2] / ll, 0.28], 52);
      pf.set(colorArray, 56);
      device.queue.writeBuffer(res.pointBufs[mirror], 0, pointData);
    }

    rf.set(cam.inv, 0);
    rf.set([...cam.eye, ctx.time], 16);
    rf.set([t.w, t.h, 1 / t.w, 1 / t.h], 20);
    rf.set([...hex(P.gridColor), P.grid], 24);
    rf.set([...hex(P.horizonColor), P.horizon], 28);
    rf.set([...hex(P.skyColor), 1], 32);
    rf.set([...hex(P.floorColor), P.reflection > 0 ? 1 : 0], 36);
    rf.set([P.gain, P.glow, 0.55, P.fovLines], 40);
    rf.set([0, 0, 0, 35 * DEG], 44);
    rf.set([4.5, 0.42, P.gridSize, P.rings], 48);
    const slots = [...rings.values()].filter((r) => r.alpha > 0).slice(0, MAX_PERSONS);
    for (let k = 0; k < 16; k++) {
      const r = slots[k];
      rf.set(r ? [r.x, r.z, r.alpha, r.slot] : [0, 0, 0, 0], 52 + k * 4);
    }
    rf.set(colorArray, 116);
    device.queue.writeBuffer(res.roomBuf, 0, roomData);

    const enc = device.createCommandEncoder();
    const pass = (viewTex) => enc.beginRenderPass({ colorAttachments: [{ view: viewTex, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    const fullPass = (viewTex, pipeline, group) => {
      const q = pass(viewTex);
      q.setPipeline(pipeline);
      q.setBindGroup(0, group);
      q.draw(3);
      q.end();
    };
    let rp = pass(t.accView);
    if (count) {
      rp.setPipeline(res.points);
      rp.setBindGroup(0, res.groups[0]);
      rp.draw(6, count);
    }
    rp.end();
    rp = pass(t.reflView);
    if (count && P.reflection > 0) {
      rp.setPipeline(res.points);
      rp.setBindGroup(0, res.groups[1]);
      rp.draw(6, count);
    }
    rp.end();
    if (P.reflection > 0) {
      fullPass(t.refl2View, res.blur, t.reflH);
      fullPass(t.reflView, res.blur, t.reflV);
    }
    fullPass(t.q1View, res.down, t.down);
    fullPass(t.q2View, res.blur, t.glowH);
    fullPass(t.q1View, res.blur, t.glowV);
    fullPass(context.getCurrentTexture().createView(), res.room, t.room);
    device.queue.submit([enc.finish()]);

    updateTags(ctx, cam.vp, frame);
    const f = persons?.floor;
    ctx.status = `${Math.round(count / 1000)}k Punkte · ${f ? `Boden ${f.height.toFixed(2)} m${f.source === 'feet' ? ' (aus Füßen)' : ''}` : 'kein Boden sichtbar'}`;
  },

  dispose() {
    targets?.textures.forEach((x) => x.destroy());
    targets = null;
    tagEls.clear();
    rings.clear();
  },
};
