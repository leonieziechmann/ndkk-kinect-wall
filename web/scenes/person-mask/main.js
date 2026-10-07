// Person mask in 2D: only the people, each in the color of its tracking slot, with relief, infrared
// detail and an outline; their id and height above them. The room shows at most as a faint ghost.
//
// Template for 2D effects on the person tracking (see /PERSONS.md): streams: ['persons'] starts it,
// then in WGSL isPerson(k), personMask(k), personAt(k), personDepthAt(k), personColor(slot), and in
// JS ctx.persons (Person objects) with ctx.kinectToScreen() for HTML on top.

import { createShaderPass } from '/lib/shader-pass.js';
import SHADE from './shade.wgsl?raw';

let pass = null;
let tags = null;
const tagEls = new Map();

function updateTags(ctx) {
  const seen = new Set();
  for (const p of ctx.params.labels ? ctx.persons : []) {
    seen.add(p.id);
    let el = tagEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pm-tag';
      tags.append(el);
      tagEls.set(p.id, el);
    }
    // above the person's box (depth image pixels -> canvas pixels -> CSS pixels)
    const b = p.image.bbox;
    const [x, y] = ctx.kinectToScreen((b[0] + b[2]) / 2, b[1]);
    el.style.transform = `translate(${(x / ctx.pixelRatio).toFixed(1)}px, ${(y / ctx.pixelRatio - 10).toFixed(1)}px) translate(-50%, -100%)`;
    el.style.color = p.css;
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
