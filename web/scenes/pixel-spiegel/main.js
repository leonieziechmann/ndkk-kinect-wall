// Pixel-Art-Spiegel: everybody in front of the wall becomes a pixel-art figure of big LED tiles,
// mirrored, in real size, with the walk stretched over the wall (shared wall core, see WALL.md).
// Each person gets an outfit by their tracking id (hair, skin, shirt, pants, shoes); the skeleton
// decides which body part a tile shows. Fast hands and feet throw off small pixel sparks.
// shade.wgsl draws the tiles, sparks.js the sparks on top, palettes.js holds the outfits.

import { createShaderPass } from '/lib/shader-pass.js';
import SHADE from './shade.wgsl?raw';
import { paletteWgsl } from './palettes.js';
import { createSparks } from './sparks.js';

// per instance: the output window may run two instances of this scene during a crossfade
const state = new WeakMap();

export default {
  wall: true,
  streams: ['persons'],
  persons: (p) => ({ mode: 'full', delay: p.exact ? 12 : 0 }),
  maxFps: 30,

  params: {
    cell: { value: 11, min: 4, max: 30, step: 0.5, label: 'Pixelgröße (cm)' },
    gap: { value: 0.16, min: 0, max: 0.45, step: 0.01, label: 'Fuge' },
    corner: { value: 0.3, min: 0, max: 1, step: 0.05, label: 'Ecken rund' },
    fill: { value: 0.4, min: 0.1, max: 0.9, step: 0.01, label: 'Schwelle (Anteil bedeckt)' },
    relief: { value: 1, min: 0, max: 1.5, step: 0.05, label: 'Licht und Schatten' },
    trail: { value: 0.5, min: 0, max: 0.95, step: 0.01, label: 'Nachbild' },
    sparks: { value: 1, min: 0, max: 3, step: 0.05, label: 'Pixel-Funken' },
    sparkSpeed: { value: 1.3, min: 0.3, max: 4, step: 0.05, label: 'Funken ab (m/s)' },
    drift: { value: 1, min: 0, max: 4, step: 0.05, label: 'Schwebende Pixel' },
    grid: { value: 0.55, min: 0, max: 1.5, step: 0.01, label: 'Raster-Helligkeit' },
    twinkle: { value: 0.6, min: 0, max: 2, step: 0.05, label: 'Raster funkeln' },
    bg: { value: '#2a1650', label: 'Rasterfarbe' },
    exact: { value: false, label: 'Exakte Skelette (+150 ms)' },
    debug: { value: false, label: 'Skelett einblenden (Test)' },
  },

  async setup(ctx) {
    const pass = await createShaderPass(ctx, { shade: paletteWgsl() + SHADE, feedback: true });
    const sparks = await createSparks(ctx);
    state.set(ctx, { pass, sparks });
  },

  frame(ctx) {
    const s = state.get(ctx);
    if (!s) return;
    s.pass.render();
    s.sparks.render();
    ctx.status = `${ctx.wall.persons.length} Pixel-Person(en), ${s.sparks.count} Funken`;
  },

  dispose(ctx) {
    state.delete(ctx);
  },
};
