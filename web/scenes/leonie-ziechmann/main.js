// Leonie Ziechmann: the ad of the one who built this installation, in the look of betula.app (light
// theme cards): a mystic birch wood in autumn, several layers deep, darker and denser towards the
// back, a warm light far behind it, golden crowns, mist, rolling ground with heather; Betula's
// white card, Inter, the green accent.
//
// Top left the contact card ("Installation von" / the name / "Softwareentwicklung und IT
// Solutions" / mail and phone). Bottom right the QR codes to betula.app and GitHub as signs on
// birch posts, the same size, half buried in a leaf heap, with a signpost "Mehr von mir hier".
//
// People in front of the wall walk through the wood as soft, cool shadows, between the trees: in
// front of the birches farther away than they are, behind the nearer ones. Without being told, they
// find out the rest: walking towards a sign blows the heap away and the code comes out whole;
// reaching into the crowns or jumping shakes leaves loose; moving sweeps the falling leaves along;
// leaves settle on whoever stands still; feet stir up the leaves on the floor; someone arriving
// sends a gust across the wall. With nobody there the heap grows back and gusts come by themselves.
//
// Files: layout.js (where things are, Betula's colors), forest.js (the wood in layers), leafpix.js
// (pixel leaves), leaves.js (what falls and flies), heap.js (the leaf heap), cards.js (card, signs,
// signpost), render.js (WebGPU), field.js (the bodies on a wall grid, from modern-events), qr.js
// (QR encoder).

import { computeLayout } from './layout.js';
import { DEPTHS, FEET, paintForest } from './forest.js';
import { SIGN_DEPTH } from './layout.js';
import { Perspective } from './persp.js';
import { createCards } from './cards.js';
import { createRenderer } from './render.js';
import { Leaves } from './leaves.js';
import { Heap } from './heap.js';
import { BodyField } from './field.js';
import { encodeQr } from './qr.js';

// per instance: the output window may run two instances of this scene during a crossfade
const state = new WeakMap();

const hexRgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(String(hex).slice(i, i + 2), 16) / 255 || 0);

/** The QR codes of `urls`, all in the same version (the same size). */
function codesFor(s, urls) {
  const key = urls.join('\n');
  if (s.qrKey !== key) {
    s.qrKey = key;
    const safe = (u, v) => {
      try {
        return encodeQr(u || ' ', 'M', v);
      } catch (e) {
        console.warn(e);
        return encodeQr(' ', 'M', v);
      }
    };
    const v = Math.max(1, ...urls.map((u) => safe(u, 1).version));
    s.qr = urls.map((u) => safe(u, v));
  }
  return s.qr;
}

export default {
  wall: true,
  streams: ['persons'],
  persons: { mode: 'full', delay: 0 }, // live: the heap and the leaves react at once
  maxFps: 30,

  params: {
    eyebrow: { value: 'Installation von', label: 'Kleine Zeile oben', folder: 'Text' },
    name: { value: 'Leonie Ziechmann', label: 'Name', folder: 'Text' },
    lead: { value: 'Softwareentwicklung und IT Solutions', label: 'Unterzeile', folder: 'Text' },
    mail: { value: 'info@leonieziechmann.de', label: 'E-Mail', folder: 'Text' },
    phone: { value: '+49 171 2077119', label: 'Telefon', folder: 'Text' },

    qrTitle: { value: 'Mehr von mir hier', label: 'Wegweiser', folder: 'Links' },
    links: { value: 'beide', options: ['beide', 'Betula', 'GitHub'], label: 'QR-Schilder', folder: 'Links' },
    link1: { value: 'https://betula.app', label: 'Link 1', folder: 'Links' },
    label1: { value: 'betula.app', label: 'Link 1: Name', folder: 'Links' },
    small1: { value: 'BTU-Modulkatalog', label: 'Link 1: Zusatz', folder: 'Links' },
    link2: { value: 'https://github.com/leonieziechmann', label: 'Link 2', folder: 'Links' },
    label2: { value: 'GitHub', label: 'Link 2: Name', folder: 'Links' },
    small2: { value: '@leonieziechmann', label: 'Link 2: Zusatz', folder: 'Links' },
    qrModule: { value: 3, min: 2, max: 5, step: 1, label: 'Modulgröße (LEDs)', folder: 'Links' },

    heap: { value: true, label: 'Laubhaufen vor den Schildern', folder: 'Laubhaufen' },
    blow: { value: 1, min: 0.2, max: 3, step: 0.05, label: 'Wegpusten (Empfindlichkeit)', folder: 'Laubhaufen' },
    regrow: { value: 40, min: 5, max: 180, step: 1, label: 'Wächst nach in (s)', folder: 'Laubhaufen' },
    regrowDelay: { value: 6, min: 0, max: 60, step: 1, label: 'Wächst erst nach (s) Ruhe', folder: 'Laubhaufen' },

    backWood: { value: true, label: 'Nur im hinteren Wald', folder: 'Personen' },
    backNear: { value: 3.0, min: 1.5, max: 5, step: 0.05, label: 'Hinterer Wald ab (m Tiefe)', folder: 'Personen' },
    backFar: { value: 5.5, min: 2, max: 9, step: 0.05, label: 'Hinterer Wald bis (m Tiefe)', folder: 'Personen' },
    nearSize: { value: 1, min: 0.4, max: 2, step: 0.01, label: 'Größe (1 = echt bei 1,5 m Tiefe)', folder: 'Personen' },
    spread: { value: 1, min: 0.5, max: 1.5, step: 0.01, label: 'Sichtfeld über die Wand', folder: 'Personen' },
    near: { value: 0.78, min: 0, max: 1, step: 0.01, label: 'Schatten nah', folder: 'Personen' },
    far: { value: 0.45, min: 0, max: 1, step: 0.01, label: 'Schatten fern', folder: 'Personen' },
    soft: { value: 2.2, min: 0.5, max: 6, step: 0.1, label: 'Weiche Kante', folder: 'Personen' },
    tint: { value: '#0a0c19', label: 'Schattenfarbe', folder: 'Personen' },

    depth1: { value: DEPTHS[0], min: 0.5, max: 5, step: 0.05, label: 'Bäume hinten (m vom Sensor)', folder: 'Wald' },
    depth2: { value: DEPTHS[1], min: 0.5, max: 5, step: 0.05, label: 'Bäume Mitte (m)', folder: 'Wald' },
    depth3: { value: DEPTHS[2], min: 0.5, max: 5, step: 0.05, label: 'Bäume vorn (m)', folder: 'Wald' },
    signDepth: { value: SIGN_DEPTH, min: 0.5, max: 5, step: 0.05, label: 'Schilder (m)', folder: 'Wald' },
    hell: { value: 1, min: 0.3, max: 1, step: 0.01, label: 'Helligkeit gesamt', folder: 'Wald' },
    cardAlpha: { value: 0.97, min: 0.6, max: 1, step: 0.01, label: 'Kontaktkarte deckend', folder: 'Wald' },

    laub: { value: 3, min: 0, max: 20, step: 0.5, label: 'Blätter pro Sekunde (Ruhe)', folder: 'Laub' },
    shake: { value: 1, min: 0, max: 3, step: 0.05, label: 'Kronen schütteln', folder: 'Laub' },
    wind: { value: 1, min: 0, max: 2.5, step: 0.05, label: 'Wind', folder: 'Laub' },
    kick: { value: 1, min: 0, max: 3, step: 0.05, label: 'Bewegung wirbelt auf', folder: 'Laub' },
    stick: { value: true, label: 'Blätter bleiben auf Personen liegen', folder: 'Laub' },
    cards: { value: true, label: 'Blätter landen auf Karte und Schildern', folder: 'Laub' },
    pile: { value: 220, min: 0, max: 600, step: 10, label: 'Blätter am Boden (höchstens)', folder: 'Laub' },
  },

  async setup(ctx) {
    const renderer = await createRenderer(ctx);
    const { context } = await ctx.webgpu();
    state.set(ctx, {
      renderer,
      context,
      cards: createCards(),
      leaves: new Leaves(),
      heap: new Heap(),
      persp: new Perspective(),
      field: new BodyField(0.03),
      forestKey: '',
      forest: null,
      gen: -1,
      lastPersons: 0,
      bytes: null,
      ms: 0,
    });
  },

  frame(ctx) {
    const s = state.get(ctx);
    if (!s) return;
    const p = ctx.params;
    const wall = ctx.wall;
    const W = ctx.width;
    const H = ctx.height;

    // the links shown, their codes all the same size
    const links = [];
    if (p.links !== 'GitHub') links.push({ url: p.link1, label: p.label1, small: p.small1 });
    if (p.links !== 'Betula') links.push({ url: p.link2, label: p.label2, small: p.small2 });
    const qrs = codesFor(s, links.map((l) => l.url));
    const codes = links.map((l, i) => ({ ...l, key: l.url, qr: qrs[i], mark: /betula\.app/i.test(l.url), icon: /github\.com/i.test(l.url) ? 'github' : null }));
    const L = computeLayout(W, H, p, qrs[0]?.size ?? 29, codes.length);

    // the wood: painted once per layout
    s.renderer.ensure(W, H);
    const fk = JSON.stringify([W, H, L.canopy, L.ground, L.signs.map((r) => [r.x, r.y, r.w, r.h]), L.post]);
    const newTex = s.gen !== s.renderer.generation;
    if (fk !== s.forestKey || newTex) {
      if (fk !== s.forestKey) s.forest = paintForest(L);
      s.forestKey = fk;
      s.renderer.setForest(s.forest.layers);
    }

    // the card, the signs, the signpost
    const changed = s.cards.draw(L, {
      eyebrow: p.eyebrow,
      name: p.name,
      lead: p.lead,
      mail: p.mail,
      phone: p.phone,
      title: p.qrTitle,
      codes,
      alpha: Math.round(p.cardAlpha * 100) / 100,
    });
    if (changed || newTex) s.renderer.setCards(s.cards.canvas, s.cards.signs);
    s.gen = s.renderer.generation;

    // the bodies: rebuilt with every tracking result (and while the mouse is held, for testing)
    const k = ctx.kinect;
    const ptr = wall.pointer;
    const mouse = ptr.down && ptr.inside ? [{ x: ptr.x, y: ptr.y, r: 0.22 }] : [];
    // the people in perspective: smaller and higher up the farther away, sideways by the view's angle
    s.persp.configure(p, L, wall, FEET);
    const places = s.persp.update(ctx);
    if ((k.persons && k.fresh.persons) || mouse.length || s.mouse) {
      s.field.update(k.persons, k.rays, ctx.xSign, wall, mouse, (slot, lat, ry) => s.persp.project(slot, lat, ry));
      s.lastPersons = ctx.time;
    } else if (ctx.time - s.lastPersons > 1) s.field.clear();
    s.mouse = mouse.length > 0;
    const field = s.field.w ? s.field : null;

    // the heap and the leaves
    const t0 = performance.now();
    s.heap.layout(L, wall);
    const rects = [s.cards.hero, ...L.signs.slice(0, codes.length), ...(p.qrTitle ? [L.post] : [])];
    s.leaves.layout(L, wall, s.forest.spots, rects, s.heap, s.forest.ground);
    s.heap.update(ctx, p, places, s.leaves, field);
    s.leaves.update(ctx, p, field, places);
    if (!s.bytes || s.bytes.length !== W * H * 4) {
      s.bytes = new Uint8Array(W * H * 4);
      s.u32 = new Uint32Array(s.bytes.buffer);
    }
    s.u32.fill(0);
    let drawn = s.leaves.draw(s.u32, true);
    s.heap.draw(s.u32, W, H);
    drawn += s.leaves.draw(s.u32, false);
    s.renderer.setLeaves(s.bytes, W, H);
    s.ms = s.ms * 0.95 + (performance.now() - t0) * 0.05;

    s.renderer.render(s.context.getCurrentTexture().createView(), {
      s: L.s,
      bright: p.hell,
      near: p.near,
      far: p.far,
      soft: p.soft,
      tint: hexRgb(p.tint),
      ground: L.ground,
      depths: [p.depth1, p.depth2, p.depth3, p.signDepth],
      back: p.backWood ? [p.backNear, p.backFar] : [1, 4],
      slots: s.persp.slots,
    });
    ctx.status = `${places.length} Person(en), ${drawn} Blätter, Haufen ${Math.round(s.heap.cover * 100)} %, Laub ${s.ms.toFixed(1)} ms`;
  },

  dispose(ctx) {
    state.get(ctx)?.renderer.destroy();
    state.delete(ctx);
  },
};
