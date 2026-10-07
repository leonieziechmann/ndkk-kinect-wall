// 2D shader scene: the depth image as glowing contour lines that drift slowly, with infrared
// brightness and fading trails. The whole look is one WGSL function in shade.wgsl; every param below
// is available there as P.<name>. Fastest template for new ideas: edit shade.wgsl, save, look.

import { createShaderPass } from '/lib/shader-pass.js';
import SHADE from './shade.wgsl?raw';

let pass = null;

export default {
  streams: ['depth', 'ir'],

  params: {
    spacing: { value: 0.12, min: 0.02, max: 0.5, step: 0.005, label: 'Linienabstand (m)' },
    lineWidth: { value: 0.18, min: 0.02, max: 0.9, step: 0.01, label: 'Linienbreite' },
    speed: { value: 0.25, min: -2, max: 2, step: 0.01, label: 'Drift' },
    irFill: { value: 0.22, min: 0, max: 1, step: 0.01, label: 'IR-Füllung' },
    trail: { value: 0.86, min: 0, max: 0.98, step: 0.01, label: 'Nachleuchten' },
    nearColor: { value: '#ffd27a', label: 'Farbe nah' },
    farColor: { value: '#3b6cff', label: 'Farbe fern' },
  },

  async setup(ctx) {
    pass = await createShaderPass(ctx, { shade: SHADE, feedback: true });
  },

  frame() {
    pass.render();
  },
};
