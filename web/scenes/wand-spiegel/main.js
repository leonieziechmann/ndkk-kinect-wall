// Wand-Spiegel: the people as glowing silhouettes on the LED wall, placed by the shared wall core
// (ctx.wall, see WALL.md): mirrored, the walk stretched over the whole wall, bodies in real size.
// The smallest example of a wall scene: `wall: true` (the canvas is the LED image) and wallPerson(uv)
// in the shader. Wall size, Kinect position and the mapping come from the control center (/control/).

import { createShaderPass } from '/lib/shader-pass.js';
import SHADE from './shade.wgsl?raw';

let pass = null;

export default {
  wall: true,
  streams: ['persons'],
  persons: { mode: 'full', delay: 0 }, // live: the silhouettes follow without delay

  params: {
    fill: { value: 0.35, min: 0, max: 1.5, step: 0.01, label: 'Körper füllen' },
    outline: { value: 1.4, min: 0, max: 4, step: 0.05, label: 'Umriss' },
    glow: { value: 0.7, min: 0, max: 3, step: 0.05, label: 'Glühen' },
    ir: { value: 0.6, min: 0, max: 1, step: 0.01, label: 'IR-Struktur' },
    trail: { value: 0.88, min: 0, max: 0.98, step: 0.01, label: 'Nachleuchten' },
    rise: { value: 1.5, min: -6, max: 6, step: 0.1, label: 'Spuren steigen (LEDs/Bild)' },
    nearColor: { value: '#ff2d6a', label: 'Farbe nah' },
    farColor: { value: '#3d4bff', label: 'Farbe fern' },
  },

  async setup(ctx) {
    pass = await createShaderPass(ctx, { shade: SHADE, feedback: true });
  },

  frame(ctx) {
    pass.render();
    ctx.status = `${ctx.wall.persons.length} Person(en) auf der Wand`;
  },
};
