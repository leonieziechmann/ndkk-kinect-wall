// Person mask in 2D: only the people, each in the color of its tracking slot, with relief, infrared
// detail and an outline; their id and height above them. The room shows at most as a faint ghost.
//
// Template for 2D effects on the person tracking: streams: ['persons'] starts it, then in WGSL
// isPerson(k), personMask(k), personAt(k), personDepthAt(k), personColor(slot), and in JS
// ctx.kinect.persons.list (see /lib/persons.js).

import { createShaderPass } from '/lib/shader-pass.js';
import { PERSON_COLORS } from '/lib/persons.js';
import SHADE from './shade.wgsl?raw';

let pass = null;
let tags = null;
const tagEls = new Map();

/** Depth image pixel (u, v) -> CSS pixels on the screen, matching kinectUv() in the shader. */
function screenOf(ctx, u, v) {
  let kx = (u + 0.5) / 512;
  let ky = (v + 0.5) / 424;
  if (ctx.xSign < 0) kx = 1 - kx;
  const screen = ctx.width / Math.max(1, ctx.height);
  const image = 512 / 424;
  kx -= 0.5;
  ky -= 0.5;
  if (screen > image) ky = (ky * screen) / image;
  else kx = (kx * image) / screen;
  return [((kx + 0.5) * ctx.width) / ctx.pixelRatio, ((ky + 0.5) * ctx.height) / ctx.pixelRatio];
}

function updateTags(ctx) {
  const list = ctx.params.labels ? (ctx.kinect.persons?.list ?? []) : [];
  const seen = new Set();
  for (const p of list) {
    if (!p.visible) continue;
    seen.add(p.id);
    let el = tagEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pm-tag';
      tags.append(el);
      tagEls.set(p.id, el);
    }
    const [x, y] = screenOf(ctx, (p.bbox[0] + p.bbox[2]) / 2, p.bbox[1]);
    el.style.transform = `translate(${x.toFixed(1)}px, ${(y - 10).toFixed(1)}px) translate(-50%, -100%)`;
    el.style.color = PERSON_COLORS[p.slot];
    el.textContent = `#${p.id} · ${p.height.toFixed(2)} m`;
  }
  for (const [id, el] of tagEls) {
    if (!seen.has(id)) {
      el.remove();
      tagEls.delete(id);
    }
  }
}

export default {
  streams: ['persons', 'ir'],

  params: {
    room: { value: 0, min: 0, max: 1, step: 0.01, label: 'Raum (Kamerabild)' },
    shading: { value: 0.7, min: 0, max: 1, step: 0.01, label: 'Relief' },
    ir: { value: 0.45, min: 0, max: 1, step: 0.01, label: 'IR-Details' },
    outline: { value: 1, min: 0, max: 3, step: 0.05, label: 'Kontur' },
    labels: { value: true, label: 'ID und Größe zeigen' },
  },

  async setup(ctx) {
    pass = await createShaderPass(ctx, { shade: SHADE });
    tags = document.createElement('div');
    tags.className = 'pm-tags';
    const style = document.createElement('style');
    style.textContent = `
      .pm-tags { position: absolute; inset: 0; overflow: hidden; }
      .pm-tag { position: absolute; left: 0; top: 0; padding: 2px 8px; border-radius: 4px;
        font: 600 14px/1.3 ui-monospace, Consolas, monospace; letter-spacing: 0.04em;
        background: rgba(0, 0, 0, 0.45); white-space: nowrap; text-shadow: 0 0 8px currentColor; }`;
    ctx.dom.append(style, tags);
  },

  frame(ctx) {
    pass.render();
    updateTags(ctx);
    const p = ctx.kinect.persons;
    ctx.status = p?.floor ? `Boden ${p.floor.height.toFixed(2)} m (${p.floor.source === 'feet' ? 'aus Füßen' : 'gesehen'})` : '';
  },

  dispose() {
    tagEls.clear();
  },
};
