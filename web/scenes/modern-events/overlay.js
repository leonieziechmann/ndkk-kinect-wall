// The ad's fixed layer on top of everything: headline, rotating subline, and the QR card (yellow
// like the buttons on modern-events.de, dark modules, the address below). Drawn with Canvas 2D into
// a texture only when something changes (text, size, a subline cross-fade); the pulsing frame around
// the QR card is drawn in the shader, so the QR itself never moves or changes.

import { checkedModule } from '/lib/shader-pass.js';
import { encodeQr } from './qr.js';

const WGSL = /* wgsl */ `
struct U {
  res: vec2f,
  time: f32,
  pulse: f32,      // 0..1: someone is near the QR card
  card: vec4f,     // x0, y0, x1, y1 (px)
  ring: vec4f,     // rgb, corner radius (px)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
fn roundRect(p: vec2f, lo: vec2f, hi: vec2f, r: f32) -> f32 {
  let c = (lo + hi) * 0.5;
  let h = (hi - lo) * 0.5 - vec2f(r);
  let q = abs(p - c) - h;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let o = textureLoad(tex, vec2i(pos.xy), 0); // premultiplied
  // the frame around the card: a thin line a few LEDs outside, breathing; brighter and wider
  // apart while someone is near, with light running around it
  let d = roundRect(pos.xy, u.card.xy, u.card.zw, u.ring.w);
  let gap = 4.0 + 3.0 * u.pulse * (0.5 + 0.5 * sin(u.time * 5.0));
  let line = 1.0 - smoothstep(0.6, 1.4, abs(d - gap));
  let c = (u.card.xy + u.card.zw) * 0.5;
  let ang = atan2(pos.y - c.y, pos.x - c.x);
  let run = 0.5 + 0.5 * sin(ang * 2.0 - u.time * 3.0);
  let breathe = 0.35 + 0.15 * sin(u.time * 1.6);
  let a = line * mix(breathe, 0.55 + 0.45 * run, u.pulse) * step(0.0, d);
  let ring = vec4f(u.ring.rgb * a, a);
  return o + ring * (1.0 - o.a);
}
`;

export const YELLOW = '#fbbf24'; // the buttons on modern-events.de
const INK = '#0b1020';

const scaled = (hex, k) =>
  `rgb(${[1, 3, 5].map((i) => Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * k)).join(',')})`;

/**
 * The QR card as its own canvas: yellow, rounded, the code with a 4-module quiet zone, the address.
 * bright < 1 dims the yellow (LED walls are very bright; the dark modules keep their contrast).
 */
function drawCard(qr, mod, label, fontFamily, bright = 1) {
  const quiet = 4;
  const side = (qr.size + quiet * 2) * mod;
  const labelH = Math.round(mod * 4.6);
  const w = side;
  const h = side + labelH;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  const r = Math.round(mod * 1.6);
  g.fillStyle = scaled(YELLOW, bright);
  g.beginPath();
  g.roundRect(0, 0, w, h, r);
  g.fill();
  g.fillStyle = INK;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) g.fillRect((x + quiet) * mod, (y + quiet) * mod, mod, mod);
  }
  // the address under the code, inside the card (the quiet zone above it stays clear)
  let size = Math.round(labelH * 0.62);
  g.font = `800 ${size}px ${fontFamily}`;
  const maxW = w - mod * 3;
  const tw = g.measureText(label).width;
  if (tw > maxW) {
    size = Math.floor((size * maxW) / tw);
    g.font = `800 ${size}px ${fontFamily}`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, w / 2, side - mod * 0.9 + labelH / 2);
  return { canvas: c, w, h, r };
}

export async function createOverlay(ctx) {
  const { device, format } = await ctx.webgpu();
  const module = await checkedModule(device, WGSL, `${ctx.scene}: overlay`);
  const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
  });
  const uniBuf = ctx.track(device.createBuffer({ label: 'overlay u', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const uni = new Float32Array(12);

  let canvas = null;
  let g = null;
  let texture = null;
  let group = null;
  let qrKey = '';
  let qr = null;
  let card = null;
  let cardKey = '';
  let layoutKey = '';
  let dirty = true;
  let cardRect = [0, 0, 0, 0];
  let ringRadius = 8;

  function ensureTarget(w, h) {
    if (canvas && canvas.width === w && canvas.height === h) return;
    canvas = new OffscreenCanvas(w, h);
    g = canvas.getContext('2d');
    texture?.destroy();
    texture = device.createTexture({
      label: 'overlay',
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: texture.createView() },
      ],
    });
    dirty = true;
  }

  /** The QR code for `url` (cached). */
  function code(url) {
    if (url !== qrKey) {
      qrKey = url;
      try {
        qr = encodeQr(url || ' ', 'M');
      } catch (e) {
        console.warn(e);
        qr = encodeQr(' ', 'M');
      }
      cardKey = '';
    }
    return qr;
  }

  /**
   * Draws the layer when something changed. L: the layout (main.js), text: { line1, line2, url,
   * label, sub: [{ text, a, dy }] } (the sublines with their cross-fade state).
   */
  function update(L, text) {
    ensureTarget(ctx.width, ctx.height);
    const q = code(text.url);
    const ck = `${q.size},${qrKey},${L.mod},${text.label},${L.font},${L.cardBright}`;
    if (ck !== cardKey) {
      cardKey = ck;
      card = drawCard(q, L.mod, text.label, L.font, L.cardBright);
      dirty = true;
    }
    const lk = JSON.stringify([L, text.line1, text.line2, text.sub]);
    if (lk !== layoutKey) {
      layoutKey = lk;
      dirty = true;
    }
    if (!dirty) return;
    dirty = false;

    g.clearRect(0, 0, canvas.width, canvas.height);
    g.lineJoin = 'round';
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    // headline: white, then yellow; a black outline keeps it readable over the people
    const outline = (str, x, y, fill, size, weight, alpha = 1) => {
      if (!str) return;
      g.globalAlpha = alpha;
      g.font = `${weight} ${size}px ${L.font}`;
      g.lineWidth = Math.max(3, size * 0.16);
      g.strokeStyle = '#000';
      g.strokeText(str, x, y);
      g.fillStyle = fill;
      g.fillText(str, x, y);
      g.globalAlpha = 1;
    };
    const fit = (str, size, weight, maxW) => {
      g.font = `${weight} ${size}px ${L.font}`;
      const w = g.measureText(str).width;
      return w > maxW ? Math.floor((size * maxW) / w) : size;
    };
    const hs = Math.min(fit(text.line1, L.headSize, 800, L.textW), fit(text.line2, L.headSize, 800, L.textW));
    outline(text.line1, L.textX, L.line1Y, '#ffffff', hs, 800);
    outline(text.line2, L.textX, L.line2Y, YELLOW, hs, 800);
    g.save();
    g.beginPath();
    g.rect(L.textX - 10, L.subY - L.subSize * 1.3, L.textW + 20, L.subSize * 1.75);
    g.clip();
    for (const s of text.sub) {
      const size = fit(s.text, L.subSize, 600, L.textW);
      outline(s.text, L.textX, L.subY + s.dy, '#e8e6ff', size, 600, s.a);
    }
    g.restore();

    g.drawImage(card.canvas, L.cardX, L.cardY);
    cardRect = [L.cardX, L.cardY, L.cardX + card.w, L.cardY + card.h];
    ringRadius = card.r + 4;
    device.queue.copyExternalImageToTexture({ source: canvas }, { texture, premultipliedAlpha: true }, [canvas.width, canvas.height]);
  }

  /** Composites the layer and the card frame into `view`. pulse: 0..1 */
  function render(enc, view, pulse) {
    if (!group) return;
    const y = [0.984, 0.749, 0.141];
    uni.set([ctx.width, ctx.height, ctx.time, pulse, ...cardRect, ...y, ringRadius]);
    device.queue.writeBuffer(uniBuf, 0, uni);
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }

  /** Card size for a module size (for the layout). */
  function cardSize(url, mod) {
    const q = code(url);
    const side = (q.size + 8) * mod;
    return { w: side, h: side + Math.round(mod * 4.6), modules: q.size + 8 };
  }

  ctx.onDispose(() => texture?.destroy());
  return {
    update,
    render,
    cardSize,
    get card() {
      return cardRect;
    },
    get qr() {
      return qr;
    },
  };
}
