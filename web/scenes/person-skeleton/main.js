// Stick figures: the skeletons of the tracked persons as neon lines on black, joints as dots,
// glowing hands with short trails, optionally the silhouettes; a greeting for everyone who comes in.
//
// Template for effects on the skeletons (see /PERSONS.md):
//   - persons: (params) => ({ mode }) picks the tracker mode: 'skeleton' runs without masks (a
//     fraction of the work), 'full' adds the silhouettes
//   - in WGSL: skeletonDist(k), personJointUv(slot, J_LEFT_HAND), personVisible(slot), personBox(slot)
//   - in JS: ctx.persons (Person objects), ctx.persons.entered, ctx.kinectToScreen(u, v)

import { createShaderPass } from '/lib/shader-pass.js';
import SHADE from './shade.wgsl?raw';

let pass = null;
let greetings = null;

export default {
  streams: ['persons'],
  persons: (p) => ({ mode: p.mode === 'Skelett' ? 'skeleton' : 'full' }),

  params: {
    mode: { value: 'Skelett', options: ['Skelett', 'Silhouette', 'Beides'], label: 'Darstellung' },
    line: { value: 2.5, min: 0.5, max: 8, step: 0.1, label: 'Linien (px)' },
    dots: { value: 4, min: 0, max: 12, step: 0.5, label: 'Gelenke (px)' },
    hands: { value: 12, min: 0, max: 40, step: 0.5, label: 'Hände (px)' },
    glow: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'Glühen' },
    trails: { value: 0.8, min: 0, max: 0.97, step: 0.01, label: 'Spuren' },
    fill: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'Silhouette' },
    greet: { value: true, label: 'Neue Personen begrüßen' },
  },

  async setup(ctx) {
    pass = await createShaderPass(ctx, { shade: SHADE, feedback: true });
    greetings = document.createElement('div');
    greetings.className = 'sk-greetings';
    const style = document.createElement('style');
    style.textContent = `
      .sk-greetings { position: absolute; inset: 0; overflow: hidden; }
      .sk-hello { position: absolute; left: 0; top: 0; font: 700 22px/1 ui-monospace, Consolas, monospace;
        letter-spacing: 0.06em; white-space: nowrap; text-shadow: 0 0 12px currentColor;
        animation: sk-hello 2.4s ease-out forwards; }
      @keyframes sk-hello { 0% { opacity: 0; margin-top: 12px; } 15% { opacity: 1; margin-top: 0; }
        70% { opacity: 1; } 100% { opacity: 0; margin-top: -18px; } }`;
    ctx.dom.append(style, greetings);
  },

  frame(ctx) {
    pass.render();
    // ctx.persons.entered: who came in with this update (each person once)
    if (ctx.params.greet) {
      for (const p of ctx.persons.entered) {
        const at = p.image.joints.head ?? p.image.center;
        if (!at) continue;
        const [x, y] = ctx.kinectToScreen(at[0], at[1]);
        const el = document.createElement('div');
        el.className = 'sk-hello';
        el.textContent = `Hallo #${p.id}`;
        el.style.color = p.css;
        el.style.transform = `translate(${(x / ctx.pixelRatio).toFixed(1)}px, ${(y / ctx.pixelRatio - 40).toFixed(1)}px) translate(-50%, -100%)`;
        el.addEventListener('animationend', () => el.remove());
        greetings.append(el);
      }
    }
    const n = ctx.persons.length;
    ctx.status = n ? `${n} ${n === 1 ? 'Skelett' : 'Skelette'}` : 'niemand im Bild';
  },
};
