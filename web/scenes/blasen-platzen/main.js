// Blasen platzen: a game for the LED wall (6 m x 2 m, 1008 x 336 LEDs). Soap bubbles float up the
// wall, the people pop them with their bodies. No rules to explain, people can join and leave at any
// time, and it works with one person as with ten.
//
// A wall scene (WALL.md): the canvas is the LED image, and the wall core (ctx.wall) puts every person
// pixel onto the wall: mirrored, the walk stretched over the whole wall, bodies in real size (meters,
// not pixels: standing closer to the sensor gives no advantage). Person tracking in live mode.
// Hits are measured on the masks (grid.js), the game is in game.js, the sound in sound.js.

import { checkedModule } from '/lib/shader-pass.js';
import { DEFAULT_DELAY } from '/lib/persons.js';
import { WallGrid } from './grid.js';
import { Game, FX, neon } from './game.js';
import { Sound } from './sound.js';
import RENDER from './render.wgsl?raw';

// silhouette colors per slot: neon, no yellow or green (dim, they look olive)
const PALETTE = ['#29e6ff', '#ff3fd0', '#9a6bff', '#4d8dff', '#ff5c7a', '#3dffc0', '#c58bff', '#a8e6ff', '#ff8be8', '#00c2b8'].map((h) => {
  const v = Number.parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
});
const HEAD = `const PALETTE_SIZE = ${PALETTE.length}u;
const PALETTE = array<vec3f, ${PALETTE.length}>(${PALETTE.map((c) => `vec3f(${c.map((x) => x.toFixed(3)).join(', ')})`).join(', ')});
`;
const SPRITE_FLOATS = 16;
const MAX_SPRITES = 8192;

const slotColor = (s) => (s ? PALETTE[(s - 1) % PALETTE.length] : [1, 1, 1]);
const easeOutBack = (u) => 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2;

let S = null;

export default {
  wall: true, // the canvas is the LED image; wall size, Kinect, zone and mapping: control center
  streams: ['persons'],
  persons: (p) => ({ mode: 'full', delay: p.live ? 0 : DEFAULT_DELAY }),

  params: {
    live: { value: true, label: 'Live (weniger Verzögerung)', folder: 'Spiel' },
    count: { value: 6, min: 0, max: 40, step: 1, label: 'Blasen (Grundmenge)', folder: 'Spiel' },
    perPerson: { value: 4, min: 0, max: 12, step: 1, label: 'Blasen pro Person', folder: 'Spiel' },
    idleCount: { value: 8, min: 0, max: 40, step: 1, label: 'Blasen ohne Publikum', folder: 'Spiel' },
    size: { value: 1, min: 0.4, max: 2.5, step: 0.05, label: 'Größe', folder: 'Spiel' },
    speed: { value: 1, min: 0.2, max: 3, step: 0.05, label: 'Tempo', folder: 'Spiel' },
    popSpeed: { value: 0.8, min: 0.1, max: 3, step: 0.05, label: 'Platzen ab (m/s)', folder: 'Spiel' },
    push: { value: 0.6, min: 0, max: 3, step: 0.05, label: 'Wegschieben', folder: 'Spiel' },
    starChance: { value: 0.04, min: 0, max: 0.3, step: 0.01, label: 'Sterne (Anteil)', folder: 'Spiel' },
    giantChance: { value: 0.06, min: 0, max: 0.3, step: 0.01, label: 'Riesenblasen (Anteil)', folder: 'Spiel' },
    chainRadius: { value: 1.2, min: 0.3, max: 3, step: 0.05, label: 'Stern-Kette (m)', folder: 'Spiel' },
    waveEvery: { value: 60, min: 10, max: 400, step: 5, label: 'Welle alle … Blasen', folder: 'Spiel' },
    resetAfter: { value: 8, min: 2, max: 60, step: 1, label: 'Neue Runde nach (s leer)', folder: 'Spiel' },
    numbers: { value: true, label: 'Punkte zeigen', folder: 'Spiel' },

    fill: { value: 0.16, min: 0, max: 1, step: 0.01, label: 'Körper füllen', folder: 'Bild' },
    outline: { value: 1, min: 0, max: 2, step: 0.05, label: 'Umriss', folder: 'Bild' },
    motionGlow: { value: 0.8, min: 0, max: 2, step: 0.05, label: 'Bewegung leuchtet', folder: 'Bild' },
    brightness: { value: 1, min: 0.2, max: 2, step: 0.05, label: 'Helligkeit', folder: 'Bild' },
    sound: { value: true, label: 'Ton', folder: 'Bild' },
    volume: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Lautstärke', folder: 'Bild' },
    showFresh: { value: false, label: 'Treffer-Zellen zeigen (Test)', folder: 'Bild' },
  },

  async setup(ctx) {
    const { device, context, format } = await ctx.webgpu();
    const module = await checkedModule(device, HEAD + RENDER, 'blasen-platzen render.wgsl', HEAD.split('\n').length - 1);
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: VF, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    device.pushErrorScope('validation');
    const people = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'fullVs' },
      fragment: { module, entryPoint: 'people', targets: [{ format }] },
    });
    const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
    const sprites = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'spriteVs' },
      fragment: { module, entryPoint: 'spriteFs', targets: [{ format, blend: { color: add, alpha: add } }] },
    });
    const err = await device.popErrorScope();
    if (err) throw new Error(`Pipeline: ${err.message}`);

    const uniformBuf = ctx.track(device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const spriteBuf = ctx.track(device.createBuffer({ size: MAX_SPRITES * SPRITE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const sound = new Sound();
    const unlock = () => ctx.params.sound && sound.unlock();
    ctx.on(window, 'pointerdown', unlock);
    ctx.on(window, 'keydown', unlock);
    unlock(); // works right away in a kiosk browser that allows autoplay

    S = {
      device,
      context,
      people,
      sprites,
      layout,
      uniformBuf,
      spriteBuf,
      sampler,
      sound,
      uni: new Float32Array(16),
      spr: new Float32Array(MAX_SPRITES * SPRITE_FLOATS),
      n: 0,
      game: new Game(),
      grid: null,
      gridTex: null,
      group: null,
      gridKey: '',
      lastPersons: -1,
      lastSeq: null,
      pointer: { x: 0, y: 0, vx: 0, vy: 0, down: false },
      ensureGrid(size) {
        const key = `${size.w}x${size.h}`;
        if (key === this.gridKey) return;
        this.gridKey = key;
        this.grid = new WallGrid(size.w, size.h);
        this.gridTex?.destroy();
        this.gridTex = device.createTexture({ size: [this.grid.w, this.grid.h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        this.group = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: uniformBuf } },
            { binding: 1, resource: this.gridTex.createView() },
            { binding: 2, resource: sampler },
            { binding: 3, resource: { buffer: spriteBuf } },
          ],
        });
        this.upload();
      },
      upload() {
        const g = this.grid;
        device.queue.writeTexture({ texture: this.gridTex }, g.tex, { bytesPerRow: g.w * 4 }, [g.w, g.h]);
      },
      // one sprite (see struct Sprite in render.wgsl)
      put(x, y, sx, sy, col, a, kind, k1 = 0, k2 = 0, k3 = 0, margin = 1) {
        if (this.n >= MAX_SPRITES) return;
        const o = this.n++ * SPRITE_FLOATS;
        const s = this.spr;
        s[o] = x;
        s[o + 1] = y;
        s[o + 2] = sx;
        s[o + 3] = sy;
        s[o + 4] = col[0];
        s[o + 5] = col[1];
        s[o + 6] = col[2];
        s[o + 7] = a;
        s[o + 8] = kind;
        s[o + 9] = k1;
        s[o + 10] = k2;
        s[o + 11] = k3;
        s[o + 15] = margin;
      },
      // digits, '+' and '*' (a star); x is the center of the text
      text(str, x, y, h, col, a) {
        const adv = h * 0.78;
        const x0 = x - (adv * (str.length - 1)) / 2;
        for (let i = 0; i < str.length; i++) {
          const ch = str[i];
          const g = ch === '+' ? 10 : ch === '*' ? 11 : ch.charCodeAt(0) - 48;
          if (g < 0 || g > 11) continue;
          this.put(x0 + i * adv, y, h * 0.31, h * 0.5, col, a, FX.GLYPH, g, 0, 0, 1.35);
        }
      },
      destroy() {
        this.gridTex?.destroy();
      },
    };
    ctx.track(S);
    globalThis.__blasen = { game: S.game, get grid() { return S?.grid; }, params: ctx.params }; // for debugging and tests
  },

  frame(ctx) {
    const { device, game } = S;
    const p = ctx.params;
    const wall = ctx.wall;
    const { size, bottom } = wall.setup;
    S.ensureGrid(size);
    const grid = S.grid;
    const dt = Math.min(Math.max(ctx.dt, 0.001), 1 / 15);
    const top = bottom + size.h;

    // the people -> the wall grid, once per tracking result
    const k = ctx.kinect;
    const fresh = Boolean(ctx.persons.fresh && k.persons);
    let frameRate = 1; // 1 / Kinect frames since the last grid (normally 1)
    if (fresh) {
      if (S.lastSeq !== null) frameRate = 1 / Math.min(3, Math.max(1, k.persons.seq - S.lastSeq));
      S.lastSeq = k.persons.seq;
      S.lastPersons = ctx.time;
      grid.update(k.persons, k.rays, ctx.xSign, wall);
      S.upload();
    } else if (S.lastPersons >= 0 && ctx.time - S.lastPersons > 0.5 && grid.covered) {
      grid.clear();
      S.upload();
    }

    // the people for the game, in wall meters (placed by the wall core)
    const people = [];
    for (const q of wall.persons) {
      if (!q.inZone) continue;
      const h = q.person.head ? wall.fromWorld(q.person.head, q.slot) : [q.x, q.y + 0.6];
      people.push({ id: q.id, slot: q.slot, x: q.x, headX: h[0], headY: h[1] });
    }

    // the mouse on the wall (for testing without people)
    const m = S.pointer;
    const wp = wall.pointer;
    m.vx = m.vx * 0.5 + ((wp.x - m.x) / dt) * 0.5;
    m.vy = m.vy * 0.5 + ((wp.y - m.y) / dt) * 0.5;
    m.x = wp.x;
    m.y = wp.y;
    m.down = wp.down && wp.inside;

    game.step(dt, { wallW: size.w, top, bottom, grid, fresh, frameRate, people, persons: ctx.persons, params: p, pointer: m });
    if (p.sound) {
      S.sound.setVolume(p.volume);
      for (const e of game.events) S.sound.play(e, size.w);
    }
    game.events.length = 0;

    // sprites: bubbles, effects, numbers
    S.n = 0;
    const t = game.time;
    for (const b of game.bubbles) {
      const u = Math.min(1, (t - b.born) / b.grow);
      const sc = easeOutBack(u);
      const wob = Math.sin(t * 3.1 + b.phase) * 0.035;
      const r = b.r * sc;
      S.put(b.x, b.y, r * (1 + wob), r * (1 - wob), [1, 1, 1], Math.min(1, u * 2), FX.BUBBLE, b.hue, b.phase, b.kind, 1.35);
    }
    for (const f of game.fx) {
      const u = (t - f.t0) / f.life;
      if (f.kind === FX.RING) {
        const r = f.r0 + (f.r1 - f.r0) * (1 - (1 - u) ** 3);
        // stays bright and gets thinner (a dim magenta ring would look brownish)
        S.put(f.x, f.y, r, r, f.col, f.a * (1 - u) ** 0.5, FX.RING, f.w * (1 - 0.8 * u), 0, 0, 1 + 3 * f.w);
      } else if (f.kind === FX.DOT) {
        const s = f.size * (1 - 0.5 * u);
        S.put(f.x, f.y, s, s, f.col, f.a * (1 - u), FX.DOT, 0, 0, 0, 1.6);
      } else if (f.kind === FX.GLYPH) {
        S.text(f.text, f.x, f.y, f.h, f.col, f.a * (u < 0.6 ? 1 : (1 - u) / 0.4));
      }
    }
    if (p.numbers) {
      // the group's score in the top left corner, the record in the top right one: the people
      // stand mostly in the middle (the sensor's view is a wedge). During a wave the score shimmers.
      const H = 0.2;
      const y = top - H * 0.8;
      const scoreText = String(game.score);
      const col = game.wave > 0 ? neon(t * 0.8) : [0.85, 0.95, 1];
      if (people.length > 0 || game.score > 0) S.text(scoreText, 0.25 + (scoreText.length * H * 0.78) / 2, y, H, col, 1);
      if (game.best > 0) {
        const bestText = `*${game.best}`;
        S.text(bestText, size.w - 0.25 - (bestText.length * H * 0.6 * 0.78) / 2, y, H * 0.6, [1, 0.55, 0.95], 0.75);
      }
      // everyone's own count beside their head
      for (const q of people) {
        const n = game.perPerson.get(q.id);
        if (!n) continue;
        const s = String(n);
        S.text(s, q.headX + 0.2 + (s.length * 0.12 * 0.78) / 2, Math.min(q.headY + 0.05, top - 0.1), 0.12, slotColor(q.slot), 0.95);
      }
    }

    // uniforms and drawing
    const U = S.uni;
    U.set([ctx.width, ctx.height, size.w, size.h, bottom, t, grid.w, grid.h, p.showFresh ? 1 : 0, p.fill, p.outline, p.motionGlow, p.brightness]);
    device.queue.writeBuffer(S.uniformBuf, 0, U);
    if (S.n) device.queue.writeBuffer(S.spriteBuf, 0, S.spr, 0, S.n * SPRITE_FLOATS);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: S.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setBindGroup(0, S.group);
    pass.setPipeline(S.people);
    pass.draw(3);
    if (S.n) {
      pass.setPipeline(S.sprites);
      pass.draw(6, S.n);
    }
    pass.end();
    device.queue.submit([enc.finish()]);

    const floor = wall.room.found ? `Boden: Kinect ${wall.room.height.toFixed(2)} m` : `Boden von Hand: Kinect ${wall.room.height} m (Wand-Setup)`;
    const snd = p.sound && !S.sound.ready ? ' · Ton: einmal klicken' : '';
    ctx.status = `${people.length} Person(en) · ${game.bubbles.length} Blasen · ${game.score} Punkte (Rekord ${game.best}) · ${floor}${snd}`;
  },

  dispose() {
    S = null;
  },
};
