// Modern Events: the sponsor's ad on the LED wall, a little interactive.
//
// The layout (LED image, see WALL.md): the Modern Events logo as an LED panel of dots on top, the
// message below it ("Diese LED-Wand können Sie mieten."), a rotating subline, and the QR code to
// modern-events.de/led-wand-mieten on a yellow card at the side. The QR card never moves and nothing
// is drawn over it.
//
// The people in front of the wall appear as LED dots in a blue-violet-magenta gradient (people.wgsl,
// mirrored, real size, through the shared wall core). In the logo panel they light up its dots while
// the letters stay white, so the logo stays readable with a crowd in front. Moving through the logo
// or waving in it splashes its dots, which spring back when one stands still (panel.js, on a grid of
// the bodies, field.js). Someone arriving sends a ripple through the logo; with nobody there, ripples
// and a glint run by themselves. Near the QR card its frame lights up. The texts and the link are
// params, so the control center can change them per show entry.

import { createShaderPass } from '/lib/shader-pass.js';
import PEOPLE from './people.wgsl?raw';
import { BodyField } from './field.js';
import { createLogoPanel } from './panel.js';
import { createOverlay } from './overlay.js';

const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
const FADE = 0.8; // s: subline change (out, then in)

// the people's gradient across the wall, the same as brand() in people.wgsl
const BLUE = [0.24, 0.36, 1.0];
const VIOLET = [0.58, 0.3, 1.0];
const MAGENTA = [1.0, 0.24, 0.62];
function brand(t, out) {
  const [a, b, u] = t < 0.5 ? [BLUE, VIOLET, t * 2] : [VIOLET, MAGENTA, t * 2 - 1];
  const v = Math.min(1, Math.max(0, u));
  for (let c = 0; c < 3; c++) out[c] = a[c] + (b[c] - a[c]) * v;
  return out;
}

// per instance: the output window may run two instances of this scene during a crossfade
const state = new WeakMap();

function computeLayout(ctx, p, overlay) {
  const W = ctx.width;
  const H = ctx.height;
  const m = Math.round(H * 0.055);
  const pitch = Math.max(3, Math.round(p.pitch));
  // the QR card: as large as asked, smaller if it does not fit the height
  let mod = Math.max(2, Math.round(p.qrModule));
  let cs = overlay.cardSize(p.url, mod);
  while (mod > 2 && cs.h > H - 2 * Math.round(H * 0.04)) cs = overlay.cardSize(p.url, --mod);
  const right = p.qrSide !== 'links';
  const cardX = right ? W - m - cs.w : m;
  const cardY = Math.round((H - cs.h) / 2);
  // the column left (or right) of it: logo panel on top, snapped to the dot grid, text below
  const gap = Math.round(m * 1.6);
  const x0 = right ? m : cardX + cs.w + gap;
  const x1 = right ? cardX - gap : W - m;
  const px0 = Math.ceil(x0 / pitch) * pitch;
  const px1 = Math.floor(x1 / pitch) * pitch;
  const py0 = Math.ceil(m / pitch) * pitch;
  const rows = Math.max(3, Math.floor((H * p.logoHeight) / pitch));
  const panel = { x: px0, y: py0, w: px1 - px0, h: rows * pitch };
  const headSize = Math.round(H * 0.168);
  const subSize = Math.round(H * 0.07);
  const line1Y = Math.round(panel.y + panel.h + H * 0.03 + headSize * 0.74);
  const line2Y = Math.round(line1Y + headSize * 1.04);
  const subY = Math.round(H - m - subSize * 0.15);
  return {
    font: FONT,
    mod,
    cardBright: Math.round(p.qrBright * 100) / 100,
    cardX,
    cardY,
    panel,
    pitch,
    textX: panel.x + 2,
    textW: panel.w - 4,
    headSize,
    line1Y,
    line2Y,
    subSize,
    subY,
  };
}

/** The sublines with their change: the old one fades out upwards, then the new one in from below. */
function sublines(p, t, size) {
  const list = String(p.unterzeilen ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length <= 1) return list.map((text) => ({ text, a: 1, dy: 0 }));
  const every = Math.max(FADE * 2, p.subEvery);
  const i = Math.floor(t / every);
  const into = t - i * every;
  if (into >= FADE) return [{ text: list[i % list.length], a: 1, dy: 0 }];
  const half = FADE / 2;
  const out = into < half;
  const u = out ? into / half : (into - half) / half;
  const e = u * u * (3 - 2 * u);
  const text = out ? list[(i - 1 + list.length) % list.length] : list[i % list.length];
  const a = Math.round((out ? 1 - e : e) * 50) / 50;
  const dy = Math.round((out ? -e : 1 - e) * size * 0.5);
  return [{ text, a, dy }];
}

export default {
  wall: true,
  streams: ['persons'],
  persons: { mode: 'full', delay: 0 }, // live: the logo reacts at once
  maxFps: 30,

  params: {
    zeile1: { value: 'Diese LED-Wand', label: 'Zeile 1 (weiß)', folder: 'Text' },
    zeile2: { value: 'können Sie mieten.', label: 'Zeile 2 (gelb)', folder: 'Text' },
    unterzeilen: {
      value: 'Für Konzerte, Festivals, Messen und Firmenfeiern | Inklusive Anlieferung, Aufbau und Betreuung | Cottbus · Lausitz · Berlin · Dresden',
      label: 'Unterzeilen (mit | getrennt)',
      folder: 'Text',
    },
    subEvery: { value: 6, min: 2, max: 30, step: 0.5, label: 'Unterzeile wechselt alle (s)', folder: 'Text' },

    url: { value: 'https://modern-events.de/led-wand-mieten', label: 'Link im QR-Code', folder: 'QR-Code' },
    adresse: { value: 'modern-events.de', label: 'Adresse unter dem Code', folder: 'QR-Code' },
    qrModule: { value: 7, min: 3, max: 10, step: 1, label: 'Modulgröße (LEDs)', folder: 'QR-Code' },
    qrSide: { value: 'rechts', options: ['rechts', 'links'], label: 'Seite', folder: 'QR-Code' },
    qrBright: { value: 1, min: 0.4, max: 1, step: 0.01, label: 'Helligkeit der Karte', folder: 'QR-Code' },

    logo: { value: 'MODERN EVENTS', label: 'Logo-Text', folder: 'Logo' },
    pitch: { value: 6, min: 4, max: 12, step: 1, label: 'Punktabstand (LEDs)', folder: 'Logo' },
    dotSize: { value: 0.8, min: 0.4, max: 1, step: 0.02, label: 'Punktgröße', folder: 'Logo' },
    logoHeight: { value: 0.36, min: 0.2, max: 0.5, step: 0.01, label: 'Höhe (Anteil der Wand)', folder: 'Logo' },
    panel: { value: 0.85, min: 0, max: 1.5, step: 0.01, label: 'Helligkeit Fläche', folder: 'Logo' },
    letters: { value: 1, min: 0.3, max: 1, step: 0.01, label: 'Helligkeit Schrift', folder: 'Logo' },
    glint: { value: 1, min: 0, max: 2, step: 0.05, label: 'Glanz', folder: 'Logo' },
    backing: { value: 1, min: 0, max: 1, step: 0.05, label: 'Verdeckt Personen dahinter', folder: 'Logo' },

    kick: { value: 1, min: 0, max: 3, step: 0.05, label: 'Bewegung wirbelt Punkte auf', folder: 'Interaktion' },
    push: { value: 0, min: 0, max: 3, step: 0.05, label: 'Punkte weichen Körpern aus', folder: 'Interaktion' },
    springHz: { value: 1.1, min: 0.2, max: 3, step: 0.05, label: 'Zurückfedern (Hz)', folder: 'Interaktion' },
    ripples: { value: true, label: 'Wellen (Ankunft, Leerlauf)', folder: 'Interaktion' },
    attractEvery: { value: 9, min: 3, max: 60, step: 1, label: 'Welle ohne Publikum alle (s)', folder: 'Interaktion' },

    people: { value: 0.85, min: 0, max: 1.5, step: 0.01, label: 'Helligkeit Personen', folder: 'Personen' },
    rim: { value: 0.45, min: 0, max: 1, step: 0.01, label: 'Umriss hell', folder: 'Personen' },
    ir: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'IR-Struktur', folder: 'Personen' },
    grid: { value: 0, min: 0, max: 1, step: 0.01, label: 'Raster im Hintergrund', folder: 'Personen' },
  },

  async setup(ctx) {
    const pass = await createShaderPass(ctx, { shade: PEOPLE });
    const panel = await createLogoPanel(ctx);
    const overlay = await createOverlay(ctx);
    const { device, context } = await ctx.webgpu();
    state.set(ctx, { device, context, pass, panel, overlay, field: new BodyField(0.03), hasField: false, pulse: 0, empty: 0, nextAttract: 2, nextWelcome: 0 });
  },

  frame(ctx) {
    const s = state.get(ctx);
    if (!s) return;
    const p = ctx.params;
    const wall = ctx.wall;
    const L = computeLayout(ctx, p, s.overlay);
    s.panel.build(L.panel, L.pitch, p.logo || ' ', `900 {size}px ${FONT}`);

    // the bodies: rebuilt with every tracking result (and while the mouse is held, for testing)
    const k = ctx.kinect;
    const ptr = wall.pointer;
    const mouse = ptr.down && ptr.inside ? [{ x: ptr.x, y: ptr.y, r: 0.22 }] : [];
    if ((k.persons && k.fresh.persons) || mouse.length || s.mouse) {
      s.field.update(k.persons, k.rays, ctx.xSign, wall, mouse);
      s.hasField = s.field.covered > 0;
    }
    s.mouse = mouse.length > 0;

    // ripples: someone arrives (from their head), or nobody there for a while
    const persons = wall.persons;
    if (p.ripples) {
      for (const person of ctx.persons?.entered ?? []) {
        if (ctx.time < s.nextWelcome) break; // a group arriving is one wave
        s.nextWelcome = ctx.time + 1.5;
        const head = wall.joint(person, 'head') ?? [wall.place(person)?.x ?? 3, 1.5];
        const [x, y] = wall.px(head);
        s.panel.ripple(x, Math.min(y, L.panel.y + L.panel.h), 0.6);
      }
      s.empty = persons.length ? 0 : s.empty + ctx.dt;
      if (s.empty > 3 && ctx.time > s.nextAttract) {
        const r = L.panel;
        s.panel.ripple(r.x + Math.random() * r.w, Math.random() < 0.5 ? r.y + r.h : r.y, 0.8);
        s.nextAttract = ctx.time + p.attractEvery * (0.8 + Math.random() * 0.4);
      }
    }
    const moved = s.panel.step(s.hasField ? s.field : null, p);

    s.overlay.update(L, {
      line1: p.zeile1,
      line2: p.zeile2,
      url: p.url,
      label: p.adresse,
      sub: sublines(p, ctx.time, L.subSize),
    });

    // the QR card's frame lights up while someone stands near it (wall m, up to 1.6 m beside it)
    const [cx0, , cx1] = s.overlay.card;
    const cardX = (((cx0 + cx1) / 2) * wall.size.w) / ctx.width;
    let near = 0;
    for (const q of persons) near = Math.max(near, Math.min(1, Math.max(0, 1.6 - Math.abs(q.x - cardX)) / 0.8) * (q.dist < 3.5 ? 1 : 0.5));
    s.pulse += (near - s.pulse) * (1 - Math.exp(-ctx.dt * 3));

    s.pass.render();
    const enc = s.device.createCommandEncoder();
    const view = s.context.getCurrentTexture().createView();
    s.panel.render(enc, view, p, brand);
    s.overlay.render(enc, view, s.pulse);
    s.device.queue.submit([enc.finish()]);
    ctx.status = `${persons.length} Person(en), ${moved} Logo-Punkte unterwegs`;
  },

  dispose(ctx) {
    state.delete(ctx);
  },
};
