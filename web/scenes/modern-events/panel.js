// The Modern Events logo as an LED panel: a block of dots in the logo's blue-violet gradient with
// "MODERN EVENTS" in white dots (like the LED panel on modern-events.de). Every dot is a particle on
// a spring to its place.
//
// The people show up in the panel itself: the background dots they cover light up in the people's
// colors, the letters stay white, so the logo stays readable however many stand there. Moving
// outlines kick the dots (BodyField kicks): walking through the logo or waving in it splashes the
// dots, which spring back as soon as one stands still. Ripples (someone arrives, attract loop) run
// through it. Optionally ("push") the dots also make way for the bodies like a curtain.
//
// Drawn as instanced quads on whole LEDs in two passes: first the black backing of the dots still at
// home (it hides the people layer behind the intact panel), then the dots themselves.

import { checkedModule } from '/lib/shader-pass.js';

const FLOATS = 8; // x, y (px), half cell (px), dot radius (px), r, g, b, backing alpha

const WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> res: vec4f;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) col: vec3f,
  @location(2) back: f32,
  @location(3) rad: f32,
};
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) c: vec4f) -> VOut {
  var corner = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let local = corner[vi] * a.z;
  let p = a.xy + local;
  var out: VOut;
  out.pos = vec4f(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, 0.0, 1.0);
  out.local = local;
  out.col = c.rgb;
  out.back = c.a;
  out.rad = a.w;
  return out;
}
@fragment fn fsBack(in: VOut) -> @location(0) vec4f { return vec4f(0.0, 0.0, 0.0, in.back); }
@fragment fn fsDot(in: VOut) -> @location(0) vec4f {
  let cover = clamp(in.rad - length(in.local) + 0.5, 0.0, 1.0);
  return vec4f(in.col * cover, cover);
}
`;

const hex = (h) => {
  const v = Number.parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// the logo block, a bit brighter than on screen (LEDs on black)
const BLUE = hex('#2c40c4');
const INDIGO = hex('#3d32b4');
const PURPLE = hex('#8a2b9c');
const PINK = hex('#d8327e');
const WHITE = hex('#fffbf1');

/**
 * Which cells of a cols x rows grid the text covers (supersampled coverage > threshold). The text is
 * condensed sideways (squeeze) so that its letters get more rows: a long one-line logo is limited by
 * the width, and 10 rows read much better than 8.
 */
function letterCells(text, cols, rows, font, squeeze = 0.74) {
  const S = 8;
  const canvas = new OffscreenCanvas(cols * S, rows * S);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  // the largest size that fits: 86 % of the width, cap height 62 % of the height
  let size = rows * S;
  g.font = font.replace('{size}', size);
  const capRatio = 0.72;
  const wFit = (cols * S * 0.86) / Math.max(1, g.measureText(text).width * squeeze);
  const hFit = (rows * S * 0.62) / (size * capRatio);
  size = Math.floor(size * Math.min(wFit, hFit));
  g.font = font.replace('{size}', size);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.setTransform(squeeze, 0, 0, 1, (cols * S) / 2, 0);
  g.fillText(text, 0, (rows * S) / 2 + (size * capRatio) / 2);
  const img = g.getImageData(0, 0, cols * S, rows * S).data;
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) sum += img[((r * S + y) * cols * S + c * S + x) * 4 + 3];
      out[r * cols + c] = sum / (S * S * 255) > 0.42 ? 1 : 0;
    }
  }
  return out;
}

export async function createLogoPanel(ctx) {
  const { device, format } = await ctx.webgpu();
  const module = await checkedModule(device, WGSL, `${ctx.scene}: panel`);
  const vertex = {
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
  };
  const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  const bindLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
  const pipe = (entryPoint) => device.createRenderPipeline({ layout, vertex, fragment: { module, entryPoint, targets: [{ format, blend }] } });
  const backPipe = pipe('fsBack');
  const dotPipe = pipe('fsDot');
  const resBuf = ctx.track(device.createBuffer({ label: 'panel res', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const group = device.createBindGroup({ layout: bindLayout, entries: [{ binding: 0, resource: { buffer: resBuf } }] });

  let key = '';
  let n = 0;
  let buffer = null;
  let data = null;
  let home = null; // x, y per dot
  let pos = null;
  let vel = null;
  let base = null; // r, g, b per dot
  let letter = null;
  let cover = null; // per dot: 0 nobody, 1 a person, 2 a person's outline
  let lastSeq = -1;
  let rect = null;
  let pitch = 6;
  const ripples = []; // { x, y, t0, amp }
  const sample = [0, 0, 0];

  /** (Re)builds the dots for a panel rect (px) when it or the text changes. */
  function build(r, p, text, font) {
    const k = `${r.x},${r.y},${r.w},${r.h},${p},${text},${font}`;
    if (k === key) return;
    key = k;
    rect = r;
    pitch = p;
    const cols = Math.max(4, Math.floor(r.w / p));
    const rows = Math.max(3, Math.floor(r.h / p));
    const x0 = r.x + Math.floor((r.w - cols * p) / 2);
    const y0 = r.y + Math.floor((r.h - rows * p) / 2);
    const cells = letterCells(text, cols, rows, font);
    const round = 2.6; // corner radius in cells
    const list = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // rounded corners of the block
        const dx = Math.max(0, round - (col + 0.5), col + 0.5 - (cols - round));
        const dy = Math.max(0, round - (row + 0.5), row + 0.5 - (rows - round));
        if (dx * dx + dy * dy > round * round) continue;
        const u = (col + 0.5) / cols;
        const v = (row + 0.5) / rows;
        // the logo's gradient: blue, indigo, purple; pink in two corners; faint diagonal facets
        let c = u < 0.5 ? mix3(BLUE, INDIGO, u * 2) : mix3(INDIGO, PURPLE, (u - 0.5) * 2);
        const aspect = (rows * p) / (cols * p);
        const bl = u + (1 - v) * aspect * 0.55;
        const tr = 1 - u + v * aspect * 0.55;
        if (bl < 0.09) c = mix3(c, PINK, 0.85);
        else if (tr < 0.07) c = mix3(c, PINK, 0.7);
        const facet = Math.floor((u * cols + v * rows) / (rows * 1.6)) % 2 ? 1 : 0.86;
        c = c.map((x) => x * facet);
        const isLetter = cells[row * cols + col] === 1;
        list.push({ x: x0 + col * p + p / 2, y: y0 + row * p + p / 2, c: isLetter ? WHITE : c, letter: isLetter });
      }
    }
    n = list.length;
    home = new Float32Array(n * 2);
    pos = new Float32Array(n * 2);
    vel = new Float32Array(n * 2);
    base = new Float32Array(n * 3);
    letter = new Uint8Array(n);
    cover = new Uint8Array(n);
    list.forEach((d, i) => {
      home[2 * i] = pos[2 * i] = d.x;
      home[2 * i + 1] = pos[2 * i + 1] = d.y;
      base.set(d.c, 3 * i);
      letter[i] = d.letter ? 1 : 0;
    });
    data = new Float32Array(n * FLOATS);
    buffer?.destroy();
    buffer = device.createBuffer({ label: 'panel dots', size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  /** A ripple from (x, y) px through the panel. */
  function ripple(x, y, amp = 1) {
    ripples.push({ x, y, t0: ctx.time, amp });
    if (ripples.length > 8) ripples.shift();
  }

  /**
   * One simulation step. field: BodyField (null = nobody), p: params. Returns how many dots are
   * out of place (for the status line).
   */
  function step(field, p) {
    if (!n) return 0;
    const S = ctx.wall.setup;
    const sx = S.size.w / ctx.width;
    const sy = S.size.h / ctx.height;
    const top = S.bottom + S.size.h;
    const dtAll = Math.min(ctx.dt, 0.1);
    const subs = 2;
    const dt = dtAll / subs;
    const w0 = 2 * Math.PI * p.springHz;
    const k = w0 * w0;
    const damp = 2 * 0.45 * w0;
    const margin = 0.05; // m: with "push", the dots settle about this far outside the outline
    const push = 9000 * p.push; // px/s^2 at the outline
    const maxV = 2600;
    const now = ctx.time;
    for (let i = ripples.length - 1; i >= 0; i--) if (now - ripples[i].t0 > 3) ripples.splice(i, 1);

    // who stands on which dot (its home), and the kicks of moving outlines (once per result)
    const fresh = field && field.seq !== lastSeq;
    if (field) lastSeq = field.seq;
    const kickGain = 520 * p.kick; // px/s per cell the outline moved
    let out = 0;
    for (let i = 0; i < n; i++) {
      const ix = 2 * i;
      let x = pos[ix];
      let y = pos[ix + 1];
      let vx = vel[ix];
      let vy = vel[ix + 1];
      const hx = home[ix];
      const hy = home[ix + 1];
      if (field) {
        const c = field.cellAt(hx * sx, top - hy * sy, top);
        cover[i] = c >= 0 && field.occ[c] ? (field.sd[c] > -1.6 * field.cell ? 2 : 1) : 0;
        if (fresh) {
          const q = field.cellAt(x * sx, top - y * sy, top);
          if (q >= 0) {
            vx += field.kx[q] * kickGain;
            vy -= field.ky[q] * kickGain;
          }
        }
      } else cover[i] = 0;
      for (let s = 0; s < subs; s++) {
        let ax = k * (hx - x) - damp * vx;
        let ay = k * (hy - y) - damp * vy;
        if (field && push > 0) {
          field.sample(x * sx, top - y * sy, top, sample);
          const d = sample[0];
          if (d < margin) {
            let gx = sample[1];
            let gy = -sample[2]; // to px: y down
            const gl = Math.hypot(gx, gy);
            if (gl > 1e-3) {
              gx /= gl;
              gy /= gl;
            } else {
              gx = i % 2 ? 1 : -1; // on a body's middle line: sideways
              gy = 0;
            }
            const f = push * Math.min(3, (margin - d) / margin);
            ax += gx * f;
            ay += gy * f;
          }
        }
        for (const r of ripples) {
          const age = now - r.t0;
          const dx = hx - r.x;
          const dy = hy - r.y;
          const dist = Math.hypot(dx, dy) + 1e-3;
          const q = (dist - age * 520) / 26;
          if (q > -3 && q < 3) {
            const f = r.amp * 5200 * Math.exp(-q * q) * Math.max(0, 1 - age / 2.2);
            ax += (dx / dist) * f;
            ay += (dy / dist) * f;
          }
        }
        vx += ax * dt;
        vy += ay * dt;
        const sp = Math.hypot(vx, vy);
        if (sp > maxV) {
          vx *= maxV / sp;
          vy *= maxV / sp;
        }
        x += vx * dt;
        y += vy * dt;
      }
      pos[ix] = x;
      pos[ix + 1] = y;
      vel[ix] = vx;
      vel[ix + 1] = vy;
      if (Math.abs(x - hx) + Math.abs(y - hy) > pitch * 0.6) out++;
    }
    return out;
  }

  /**
   * Writes the instances and draws backing + dots into `view` (loadOp load). brand(t, out): the
   * people's gradient (the same as people.wgsl), t = 0..1 across the wall.
   */
  function render(enc, view, p, brand) {
    if (!n) return;
    const half = pitch / 2;
    const rad = pitch * p.dotSize * 0.5;
    const t = ctx.time;
    // the glint: a diagonal band of light sweeping over the panel every few seconds
    const period = 7;
    const sweep = ((t % period) / 2.2) * (rect.w + rect.h * 2) - rect.h;
    const col = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const ix = 2 * i;
      const x = pos[ix];
      const y = pos[ix + 1];
      const off = Math.hypot(x - home[ix], y - home[ix + 1]);
      const speed = Math.hypot(vel[ix], vel[ix + 1]);
      const back = 1 - Math.min(1, Math.max(0, (off - pitch * 0.25) / (pitch * 0.9)));
      const band = x - rect.x + (y - rect.y) * 0.6 - sweep;
      const glint = Math.exp(-(band * band) / 1400) * 0.5 * p.glint;
      if (letter[i]) {
        const l = p.letters;
        col[0] = base[3 * i] * l;
        col[1] = base[3 * i + 1] * l;
        col[2] = base[3 * i + 2] * l;
      } else if (cover[i]) {
        // a person on the panel: the dots light up in the people's colors, the outline lighter
        brand(home[ix] / ctx.width, col);
        const b = p.people * 1.1;
        const rim = cover[i] === 2 ? p.rim : 0;
        for (let c = 0; c < 3; c++) col[c] = (col[c] + (1 - col[c]) * rim) * b;
      } else {
        col[0] = base[3 * i] * p.panel;
        col[1] = base[3 * i + 1] * p.panel;
        col[2] = base[3 * i + 2] * p.panel;
      }
      // fast dots flash, the glint lightens
      const boost = Math.min(0.7, speed / 1800) + glint;
      const o = i * FLOATS;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = half;
      data[o + 3] = rad;
      for (let c = 0; c < 3; c++) data[o + 4 + c] = Math.min(1, col[c] * (1 + boost) + (1 - col[c]) * boost * 0.6);
      data[o + 7] = back * p.backing;
    }
    device.queue.writeBuffer(resBuf, 0, new Float32Array([ctx.width, ctx.height, 0, 0]));
    device.queue.writeBuffer(buffer, 0, data);
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] });
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, buffer);
    pass.setPipeline(backPipe);
    pass.draw(6, n);
    pass.setPipeline(dotPipe);
    pass.draw(6, n);
    pass.end();
  }

  ctx.onDispose(() => buffer?.destroy());
  return {
    build,
    step,
    render,
    ripple,
    get rect() {
      return rect;
    },
    get count() {
      return n;
    },
  };
}
