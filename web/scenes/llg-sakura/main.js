// Ludwig-Leichhardt-Gymnasium: a spring night at the school as cozy pixel art, for the Nacht der
// kreativen Köpfe. Yozakura, cherry blossoms at night under paper lanterns, in front of the school
// with its orange tower and "ライヒハルト高校" on the facade, because the school teaches Japanese and
// has been partnered with Omiya High School (Saitama) since 1996.
//
// On top: the school's logo rebuilt in pixels, a short headline, rotating facts, and a QR code to
// llgym.de on a paper card. People in front of the wall become pixel figures (dark outline, cel tones
// from the infrared image, warm rim light from the lanterns) and play with the night without being
// told how: moving makes wind for the petals, petals settle on whoever stands still and fly off when
// they move, reaching or jumping into a crown shakes the tree, the lantern above you glows brighter
// and swings when you pass, arriving sends a gust across the wall.
//
// Everything is drawn at the art resolution (one art pixel = `pixel` x `pixel` LEDs) and snapped to
// one palette at the end (render.js). Files: pixel.js (palette, raster, fonts), painting.js (the
// backdrop), sprites.js (lanterns, petals), world.js (what moves), overlay.js (logo, text, QR card),
// render.js (WebGPU), field.js (the bodies on a wall grid), qr.js (QR encoder).

import { createRenderer, FLOATS, KIND } from './render.js';
import { createOverlay } from './overlay.js';
import { paintScene } from './painting.js';
import { World } from './world.js';
import { BodyField } from './field.js';

const FONT = '"Segoe UI Black", "Arial Black", "Segoe UI", sans-serif';
const SUB_FONT = 'Verdana, Tahoma, "Segoe UI", sans-serif';
const JP_FONT = '"Yu Gothic UI", "Yu Gothic", Meiryo, "Segoe UI", sans-serif';
const SLIDE = 0.6; // s: subline change (out, then in)

class Writer {
  constructor() {
    this.data = new Float32Array(4096 * FLOATS);
    this.n = 0;
  }
  push(x, y, hx, hy, rot, kind, p1, p2, r, g, b, a, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
    if ((this.n + 1) * FLOATS > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    const d = this.data;
    const o = this.n++ * FLOATS;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = hx;
    d[o + 3] = hy;
    d[o + 4] = rot;
    d[o + 5] = kind;
    d[o + 6] = p1;
    d[o + 7] = p2;
    d[o + 8] = r;
    d[o + 9] = g;
    d[o + 10] = b;
    d[o + 11] = a;
    d[o + 12] = u0;
    d[o + 13] = v0;
    d[o + 14] = u1;
    d[o + 15] = v1;
  }
}

/** The layout in art pixels. */
function computeLayout(AW, AH, p, overlay) {
  const m = Math.round(AH * 0.045);
  const right = p.qrSide !== 'links';
  // the QR card: as large as asked, smaller if it does not fit the height
  const quiet = 3;
  let mod = Math.max(1, Math.round(p.qrModule));
  let cs = overlay.cardSize(p.url, mod, quiet);
  while (mod > 1 && cs.h > AH - 2 * m) cs = overlay.cardSize(p.url, --mod, quiet);
  return {
    qrRight: right,
    font: FONT,
    subFont: SUB_FONT,
    jpFont: JP_FONT,
    mod,
    quiet,
    cardX: right ? AW - m - cs.w : m,
    cardY: Math.round(Math.max(m, (AH - cs.h) * 0.5)),
    // the text column on the other side, over the sky
    textX0: right ? m + 2 : Math.round(AW * 0.585),
    textX1: right ? Math.round(AW * 0.415) : AW - m - 2,
    textAlign: right ? 'left' : 'right',
    logoH: Math.round(AH * p.logoSize),
    logoY: Math.round(AH * 0.03),
    kickSize: Math.round(AH * 0.075),
    headSize: Math.round(AH * 0.15),
    subSize: Math.round(AH * 0.068),
    subY: AH - m,
  };
}

/** The sublines with their change: the old one slides out downwards, then the new one in. */
function sublines(p, t, size) {
  const list = String(p.unterzeilen ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length <= 1) return list.map((text) => ({ text, a: 1, dy: 0 }));
  const every = Math.max(SLIDE * 2, p.subEvery);
  const i = Math.floor(t / every);
  const into = t - i * every;
  if (into >= SLIDE) return [{ text: list[i % list.length], a: 1, dy: 0 }];
  const half = SLIDE / 2;
  const out = into < half;
  const u = out ? into / half : 1 - (into - half) / half;
  const text = out ? list[(i - 1 + list.length) % list.length] : list[i % list.length];
  return [{ text, a: 1, dy: Math.round(u * u * size * 1.6) }];
}

// per instance: the output window may run two instances of this scene during a crossfade
const state = new WeakMap();

export default {
  wall: true,
  streams: ['persons'],
  persons: { mode: 'full', delay: 0 }, // live: the petals react at once
  maxFps: 30,

  params: {
    kicker: { value: 'ようこそ！ Willkommen am LLG', label: 'Zeile oben (klein, rosa)', folder: 'Text' },
    zeile1: { value: 'Japan beginnt', label: 'Überschrift Zeile 1 (weiß)', folder: 'Text' },
    zeile2: { value: 'in Cottbus.', label: 'Überschrift Zeile 2 (orange)', folder: 'Text' },
    unterzeilen: {
      value: 'Japanisch als zweite Fremdsprache, seit 2003 | 30 Jahre Partnerschaft mit der Omiya High School | Schüleraustausch: alle zwei Jahre nach Japan | Eine der wenigen Schulen mit Japanisch',
      label: 'Unterzeilen (mit | getrennt)',
      folder: 'Text',
    },
    subEvery: { value: 6, min: 2, max: 30, step: 0.5, label: 'Unterzeile wechselt alle (s)', folder: 'Text' },
    logoSize: { value: 0.38, min: 0.25, max: 0.5, step: 0.01, label: 'Logo-Höhe (Anteil der Wand)', folder: 'Text' },

    url: { value: 'https://www.llgym.de', label: 'Link im QR-Code', folder: 'QR-Code' },
    adresse: { value: 'llgym.de', label: 'Adresse unter dem Code', folder: 'QR-Code' },
    qrModule: { value: 2, min: 1, max: 4, step: 1, label: 'Modulgröße (Pixel)', folder: 'QR-Code' },
    qrSide: { value: 'rechts', options: ['rechts', 'links'], label: 'Seite', folder: 'QR-Code' },

    pixel: { value: 2, min: 1, max: 4, step: 1, label: 'Pixelgröße (LEDs)', folder: 'Look' },
    dither: { value: 1, min: 0, max: 2, step: 0.05, label: 'Dithering (Lichter)', folder: 'Look' },
    stars: { value: 1, min: 0, max: 1.5, step: 0.05, label: 'Sterne und Sternschnuppen', folder: 'Look' },
    lanterns: { value: 1, min: 0, max: 1.5, step: 0.05, label: 'Laternen', folder: 'Look' },
    windows: { value: 0.6, min: 0, max: 1, step: 0.05, label: 'Fenster mit Licht (Anteil)', folder: 'Look' },
    windowsBright: { value: 1, min: 0, max: 1, step: 0.05, label: 'Helligkeit Fenster', folder: 'Look' },

    petals: { value: 1, min: 0, max: 3, step: 0.05, label: 'Blütenregen', folder: 'Interaktion' },
    wind: { value: 1, min: 0, max: 3, step: 0.05, label: 'Wind', folder: 'Interaktion' },
    stick: { value: true, label: 'Blüten bleiben auf Stillstehenden liegen', folder: 'Interaktion' },
    kick: { value: 1, min: 0, max: 3, step: 0.05, label: 'Bewegung macht Wind', folder: 'Interaktion' },
    shake: { value: 1, min: 0, max: 3, step: 0.05, label: 'Bäume schütteln', folder: 'Interaktion' },

    style: { value: 'Pixel-Figuren', options: ['Pixel-Figuren', 'Silhouetten'], label: 'Stil', folder: 'Personen' },
    rim: { value: 1, min: 0, max: 1, step: 0.05, label: 'Randlicht (Laternen)', folder: 'Personen' },
    irGain: { value: 1.6, min: 0.3, max: 4, step: 0.05, label: 'IR-Verstärkung (Licht und Schatten)', folder: 'Personen' },
    outline: { value: true, label: 'Dunkle Kontur', folder: 'Personen' },
  },

  async setup(ctx) {
    const renderer = await createRenderer(ctx);
    const overlay = await createOverlay();
    const s = { renderer, overlay, world: new World(), field: new BodyField(0.03), writer: new Writer(), paintKey: '', pulse: 0, mouse: false, ms: 0 };
    state.set(ctx, s);
    globalThis.__llgSakura = s; // for tests (web/.cache scripts)
  },

  frame(ctx) {
    const s = state.get(ctx);
    if (!s) return;
    const t0 = performance.now();
    const p = ctx.params;
    const wall = ctx.wall;
    const P = Math.max(1, Math.round(p.pixel));
    const AW = Math.ceil(ctx.width / P);
    const AH = Math.ceil(ctx.height / P);
    const L = computeLayout(AW, AH, p, s.overlay);

    // the backdrop: painted once per size and side
    const pk = `${AW}x${AH}:${L.qrRight}`;
    if (pk !== s.paintKey) {
      s.paintKey = pk;
      const scene = paintScene(AW, AH, L);
      s.renderer.uploadPaint(scene.canvas);
      s.world.setScene(scene);
    }

    // the bodies on the wall grid: rebuilt with every tracking result (and while the mouse is held)
    const k = ctx.kinect;
    const ptr = wall.pointer;
    const mouse = ptr.down && ptr.inside ? [{ x: ptr.x, y: ptr.y, r: 0.22 }] : [];
    if ((k.persons && k.fresh.persons) || mouse.length || s.mouse) s.field.update(k.persons, k.rays, ctx.xSign, wall, mouse);
    s.mouse = mouse.length > 0;

    const placements = wall.persons;
    s.world.step(ctx, p, s.field, placements, AW, AH);

    // the text layer
    const sheet = s.overlay.update(AW, AH, L, { kicker: p.kicker, line1: p.zeile1, line2: p.zeile2, sub: sublines(p, ctx.time, L.subSize), url: p.url, label: p.adresse });
    if (sheet) s.renderer.uploadOverlay(sheet);

    // the QR card's frame runs while someone stands near it
    const card = s.overlay.card;
    const cardX = (card[0] + card[2]) / 2 / (AW / wall.size.w);
    let near = 0;
    for (const q of placements) near = Math.max(near, Math.min(1, Math.max(0, 1.6 - Math.abs(q.x - cardX)) / 0.8) * (q.dist < 3.5 ? 1 : 0.5));
    s.pulse += (near - s.pulse) * (1 - Math.exp(-ctx.dt * 3));

    const w = s.writer;
    w.n = 0;
    s.world.emitBack(w, ctx, p, s.renderer.sheet);
    const back = w.n;
    s.world.emitFront(w, ctx, p, card, s.pulse, s.renderer.sheet);
    w.push(AW / 2, AH / 2, AW / 2, AH / 2, 0, KIND.overlay, 0, 0, 1, 1, 1, 1);
    s.renderer.render(w.data, back, w.n, { aw: AW, ah: AH, scale: P, dither: p.dither, style: p.style === 'Silhouetten' ? 1 : 0, rim: p.rim, irGain: p.irGain, outline: p.outline ? 1 : 0 });

    const c = s.world.counts;
    s.ms += (performance.now() - t0 - s.ms) * 0.05;
    ctx.status = `${placements.length} Person(en) · Blüten: ${c.air} in der Luft, ${c.on} auf Personen, ${c.ground} am Boden · ${s.ms.toFixed(1)} ms`;
  },

  dispose(ctx) {
    state.get(ctx)?.renderer.dispose();
    state.delete(ctx);
  },
};
