// Fruit Ninja for the LED wall (6 m x 2 m, 1008 x 336 LEDs). Fruit flies up in arcs, a fast hand cuts
// it: two halves with the inside showing, juice, a splash on the wall. Several in one swipe are a combo,
// bombs hurt, the star fruit starts a frenzy, the frost fruit slows time. Rounds with a bar at the top,
// everyone's points above their head, a crown for the best of the last round. No text, no sound.
//
// The people: their silhouettes from the masks (exact every frame), the blades from the skeleton's
// hands (people.js), on the wall as the shared wall core maps them (mirrored, the walk stretched over
// the whole wall, bodies in real size), dressed as ninjas (ninja.js). Tracking from the hub, live and
// exact together: cuts happen at once on the live hands (their arms come from the mask of every
// frame), and the exact skeletons that follow 150-250 ms later still cut what live missed.
// Behind it all a Japanese moon night (scenery.js): moon, pagoda, Fuji, cherry tree, petals. Look and renderer from space-invaders: a pixel layer at LED
// resolution, bloom, ripples, flashes, slow motion; moiré-safe for the LED wall.
//
// Files: people.js (silhouettes, blades), ninja.js (the costume), game.js (rules), fruits.js (the fruit
// as pixel art), scenery.js (the background), draw.js (the pixel layer, lights), render.js (WebGPU),
// fx.js (effects), pix.js (blocks, font).

import { Game } from './game.js';
import { KINDS } from './fruits.js';
import { People, RES } from './people.js';
import { FX } from './fx.js';
import { Pix, rgb, WHITE } from './pix.js';
import { drawArt, collectLights } from './draw.js';
import { createRenderer, MAX_LIGHTS } from './render.js';
import { Scenery } from './scenery.js';
import { Strokes } from './strokes.js';

// the people in cool colors; the fruit is the warm, vivid part of the picture
const PALETTE = ['#29e6ff', '#4d8dff', '#b59bff', '#3dffc0', '#a8e6ff', '#7ab8ff', '#e0f4ff', '#6f7dff', '#5ff7e0', '#ff8be8'].map(rgb);
const colorOf = (s) => (s ? PALETTE[(s - 1) % PALETTE.length] : WHITE);

// state per instance (ctx): the output window may run this scene twice at once (crossfade)
const STATES = new WeakMap();
// the render cap of the param `fps` (read by the runtime through maxFps below)
let fpsCap = 0;

function makeLayout(ctx, p) {
  const s = ctx.wall.setup;
  const W = ctx.width;
  const H = ctx.height;
  const S = Math.max(1, Math.round((p.pixelCm / 100) * ctx.wall.pxPerM[0]));
  const AW = Math.max(40, Math.floor(W / S));
  const AH = Math.max(20, Math.floor(H / S));
  return { W, H, S, AW, AH, ppm: (W / S) / s.size.w, top: s.bottom + s.size.h, bottom: s.bottom, wallW: s.size.w, key: [W, H, S].join() };
}

export default {
  wall: true, // the canvas is the LED image; wall size, Kinect, zone and mapping: control center
  streams: ['persons'],
  persons: (p) => (p.tracking === 'live' ? { mode: 'full', delay: 0 } : p.tracking === 'exakt' ? { mode: 'full' } : { mode: 'full', live: true }),
  get maxFps() {
    return fpsCap;
  },

  params: {
    roundTime: { value: 60, min: 0, max: 300, step: 5, label: 'Runde (s, 0 = endlos)', folder: 'Spiel' },
    finale: { value: 10, min: 0, max: 30, step: 1, label: 'Finale: letzte … s', folder: 'Spiel' },
    endTime: { value: 5, min: 1, max: 15, step: 0.5, label: 'Pause nach der Runde (s)', folder: 'Spiel' },
    resetAfter: { value: 6, min: 2, max: 60, step: 1, label: 'Runde abbrechen nach (s leer)', folder: 'Spiel' },
    tempo: { value: 1, min: 0.5, max: 2, step: 0.05, label: 'Tempo', folder: 'Spiel' },
    gravity: { value: 3.2, min: 1, max: 9.81, step: 0.1, label: 'Schwerkraft (m/s²)', folder: 'Spiel' },
    every: { value: 1.4, min: 0.4, max: 5, step: 0.1, label: 'Wurf alle … s', folder: 'Spiel' },
    amount: { value: 1, min: 0.2, max: 3, step: 0.05, label: 'Früchte pro Person und Wurf', folder: 'Spiel' },
    size: { value: 1, min: 0.5, max: 2, step: 0.05, label: 'Fruchtgröße', folder: 'Spiel' },
    bombs: { value: 0.1, min: 0, max: 0.5, step: 0.01, label: 'Bomben (Anteil)', folder: 'Spiel' },
    bombAfter: { value: 8, min: 0, max: 60, step: 1, label: 'Bomben ab … s der Runde', folder: 'Spiel' },
    bombPenalty: { value: 10, min: 0, max: 50, step: 1, label: 'Bombe: Punkte weg', folder: 'Spiel' },
    specials: { value: 0.05, min: 0, max: 0.3, step: 0.01, label: 'Sternfrucht/Frostfrucht (Anteil)', folder: 'Spiel' },
    frenzyTime: { value: 4, min: 1, max: 10, step: 0.5, label: 'Sternfrucht: Fruchtregen (s)', folder: 'Spiel' },
    freezeTime: { value: 4, min: 1, max: 10, step: 0.5, label: 'Frostfrucht: Zeitlupe (s)', folder: 'Spiel' },
    crown: { value: true, label: 'Krone für die/den Besten', folder: 'Spiel' },

    cutSpeed: { value: 1.3, min: 0.3, max: 4, step: 0.05, label: 'Schneiden ab (m/s)', folder: 'Klinge' },
    hit: { value: 1.2, min: 0.6, max: 2, step: 0.05, label: 'Trefferzone (× Fruchtradius)', folder: 'Klinge' },
    bladeR: { value: 0.08, min: 0, max: 0.3, step: 0.01, label: 'Klinge breit (m)', folder: 'Klinge' },
    comboGap: { value: 0.35, min: 0.1, max: 1, step: 0.05, label: 'Combo: Pause höchstens (s)', folder: 'Klinge' },
    maxJump: { value: 0.9, min: 0.2, max: 3, step: 0.05, label: 'Sprung der Hand ignorieren ab (m)', folder: 'Klinge' },
    maxSpeed: { value: 12, min: 3, max: 40, step: 0.5, label: 'Hand schneller als … m/s = Messfehler', folder: 'Klinge' },
    minConf: { value: 0.2, min: 0, max: 1, step: 0.05, label: 'Hand: Mindest-Konfidenz', folder: 'Klinge' },
    trail: { value: 0.2, min: 0.05, max: 0.8, step: 0.01, label: 'Spur (s)', folder: 'Klinge' },
    smoothDelay: { value: 0.07, min: 0, max: 0.3, step: 0.005, label: 'Klinge: wartet auf Punkte (s, glatter)', folder: 'Klinge' },
    inertia: { value: 26, min: 5, max: 80, step: 1, label: 'Klinge: Federhärte (kleiner = träger)', folder: 'Klinge' },
    bladeWidth: { value: 0.022, min: 0.005, max: 0.08, step: 0.001, label: 'Klinge: Strich breit (m)', folder: 'Klinge' },
    woosh: { value: 1, min: 0, max: 2, step: 0.05, label: 'Woosh (exakt, nachher): Stärke', folder: 'Klinge' },
    wooshWidth: { value: 0.07, min: 0.02, max: 0.2, step: 0.005, label: 'Woosh: breit (m)', folder: 'Klinge' },
    wooshLife: { value: 0.5, min: 0.15, max: 1.5, step: 0.05, label: 'Woosh: bleibt (s)', folder: 'Klinge' },
    wooshDrift: { value: 0.15, min: 0, max: 0.6, step: 0.01, label: 'Woosh: weht weiter (m)', folder: 'Klinge' },
    hitStop: { value: 0.06, min: 0, max: 0.2, step: 0.01, label: 'Treffer: kurzes Anhalten (s)', folder: 'Klinge' },
    tracking: { value: 'live + exakt', options: ['live + exakt', 'live', 'exakt'], label: 'Tracking (exakt = +150–250 ms)', folder: 'Klinge' },
    lateCuts: { value: true, label: 'Exakte Skelette schneiden nach, was live verpasst hat', folder: 'Klinge' },
    rawHands: { value: true, label: 'Hände ungeglättet (schneller)', folder: 'Klinge' },

    pixelCm: { value: 2.4, min: 1.2, max: 4, step: 0.1, label: 'Pixelgröße (cm)', folder: 'Bild' },
    cover: { value: 0.35, min: 0.1, max: 0.9, step: 0.05, label: 'Körper: Pixel bedeckt ab (Anteil)', folder: 'Bild' },
    bodyEdge: { value: 0.75, min: 0, max: 1, step: 0.05, label: 'Ninja: Kante in Spielerfarbe', folder: 'Bild' },
    sword: { value: true, label: 'Ninja: Schwert auf dem Rücken', folder: 'Bild' },
    splat: { value: 0.85, min: 0, max: 1, step: 0.05, label: 'Saftflecken', folder: 'Bild' },
    scenery: { value: 1, min: 0, max: 2, step: 0.05, label: 'Szenerie: Helligkeit', folder: 'Bild' },
    sceneryLight: { value: 2, min: 0, max: 6, step: 0.1, label: 'Szenerie: Licht vom Spiel', folder: 'Bild' },
    sceneryBloom: { value: 0.25, min: 0, max: 1, step: 0.05, label: 'Szenerie: Leuchten (Mond, Laternen)', folder: 'Bild' },
    petals: { value: 40, min: 0, max: 150, step: 1, label: 'Kirschblüten-Blätter', folder: 'Bild' },
    shootingStars: { value: true, label: 'Sternschnuppen', folder: 'Bild' },
    birds: { value: true, label: 'Vogelschwärme', folder: 'Bild' },
    lights: { value: 1, min: 0, max: 3, step: 0.05, label: 'Licht', folder: 'Bild' },
    bloom: { value: 0.7, min: 0, max: 3, step: 0.05, label: 'Leuchten', folder: 'Bild' },
    bloomWide: { value: 0.5, min: 0, max: 3, step: 0.05, label: 'Leuchten weit', folder: 'Bild' },
    shake: { value: 1, min: 0, max: 3, step: 0.1, label: 'Wackeln', folder: 'Bild' },
    chroma: { value: 1, min: 0, max: 3, step: 0.1, label: 'Farbsaum', folder: 'Bild' },
    flash: { value: 1, min: 0, max: 2, step: 0.05, label: 'Blitze', folder: 'Bild' },
    slowmo: { value: true, label: 'Zeitlupe (Combos, Frostfrucht)', folder: 'Bild' },
    brightness: { value: 1, min: 0.2, max: 1.5, step: 0.05, label: 'Helligkeit', folder: 'Bild' },
    fps: { value: '60', options: ['60', '30'], label: 'Bildrate (30 = mehr Luft fürs Tracking)', folder: 'Bild' },
  },

  async setup(ctx) {
    const renderer = await createRenderer(ctx);
    const fx = new FX();
    const S = {
      renderer,
      fx,
      pix: new Pix(8, 8),
      people: new People(),
      game: new Game(fx),
      scenery: new Scenery(),
      strokes: new Strokes(),
      lights: new Float32Array(MAX_LIGHTS * 8),
      L: null,
      key: '',
      colorOf,
      destroy() {
        renderer.destroy();
      },
    };
    ctx.track(S);
    STATES.set(ctx, S);
    // for debugging and tests: __fruit.swipe([[x, y], ...], seconds) cuts like a hand
    globalThis.__fruit = {
      KINDS,
      game: S.game,
      people: S.people,
      fx,
      params: ctx.params,
      swipe: (pts, dur = 0.25) => S.people.script(pts, dur, [1, 1, 1]),
      fake: S.people.fake,
      S,
      get ms() {
        return S.ms;
      },
    };
  },

  frame(ctx) {
    const S = STATES.get(ctx);
    if (!S) return;
    const t0 = performance.now();
    const p = ctx.params;
    fpsCap = p.fps === '30' ? 30 : 0;
    const L = (S.L = makeLayout(ctx, p));
    if (L.key !== S.key) {
      S.key = L.key;
      S.pix.resize(L.W, L.H, L.S);
      S.people.resize(L.AW * RES, L.AH * RES);
    }
    if (S.scenery.build(L) || S.renderer.needsScenery(L)) S.renderer.setScenery(L, S.scenery.buf);
    S.P = p;
    const dt = S.freeze ? 0 : Math.min(Math.max(ctx.dt, 0.001), 1 / 15); // freeze: for test pictures
    const fx = S.fx;
    fx.step(dt);
    S.scenery.step(dt, L, p);
    if (!p.slowmo) fx.slowUntil = 0;
    const game = S.game;

    // the people and their blades (real time: slow motion must not slow the hands)
    S.people.update(ctx, L, p, game.real + dt, colorOf);
    const entered = [];
    for (const q of ctx.persons.entered ?? []) entered.push(q.id);
    const t1 = performance.now();
    game.step(dt, {
      wallW: L.wallW,
      top: L.top,
      bottom: L.bottom,
      people: S.people.list,
      segs: S.people.segs,
      lateSegs: S.people.lateSegs,
      entered,
      cell: 1 / L.ppm,
      params: p,
      colorOf,
      script: (pts, dur) => S.people.script(pts, dur, [1, 1, 1]),
    });
    game.events.length = 0;
    // the show switches between rounds (WALL.md, "Games: switch between rounds"): from the countdown
    // until the crown has been seen; endless rounds have no end to wait for
    const ph = game.phase;
    ctx.holdSwitch = p.roundTime > 0 ? ph === 'ready' || ph === 'play' || (ph === 'end' && game.phaseT < Math.min(2.5, p.endTime - 1)) : undefined;
    const t2 = performance.now();

    drawArt(S);
    const nLights = collectLights(S, S.lights);
    const nTrail = S.strokes.build(S, p, game.real);
    const t3 = performance.now();
    // ripples in LED pixels
    const ledPerM = L.ppm * L.S;
    const ripples = fx.ripples.map((r) => {
      const u = (fx.time - r.t0) / r.life;
      return [r.x * ledPerM, (L.top - r.y) * ledPerM, r.speed * (fx.time - r.t0) * ledPerM, r.amp * (1 - u) ** 2];
    });
    const k = fx.shake * p.shake;
    const shake = k > 0.3 ? [Math.round((Math.random() * 2 - 1) * k * 1.5), Math.round((Math.random() * 2 - 1) * k)] : [0, 0];
    S.renderer.render({
      L,
      art: S.pix.buf,
      lights: S.lights,
      nLights,
      trail: S.strokes.buf,
      nTrail,
      ripples,
      shake,
      flash: [...fx.flashCol, fx.flashAmt * p.flash],
      chroma: fx.chroma * p.chroma,
      scenery: p.scenery,
      sceneryLight: p.sceneryLight,
      sceneryBloom: p.sceneryBloom,
      bloom: p.bloom,
      bloomWide: p.bloomWide,
      brightness: p.brightness,
      time: game.time,
    });
    // main-thread time per frame (ms, smoothed): the tracker's workers and the pose model share the machine
    const t4 = performance.now();
    const ms = (S.ms ??= { people: 0, game: 0, draw: 0, render: 0, total: 0 });
    for (const [key, v] of [['people', t1 - t0], ['game', t2 - t1], ['draw', t3 - t2], ['render', t4 - t3], ['total', t4 - t0]]) ms[key] += (v - ms[key]) * 0.05;

    const left = game.phase === 'play' && p.roundTime > 0 ? ` · noch ${Math.ceil(game.roundLeft)} s` : '';
    let best = 0;
    for (const s of game.scores.values()) best = Math.max(best, s.pts);
    ctx.status = `${S.people.list.length} Person(en) · ${game.phase}${left} · ${game.fruits.length} Früchte · ${game.stats.cut} geschnitten (${game.stats.late} exakt nachgeschnitten) · Bestwert ${best} · Tracking ${ctx.persons.mode}`;
  },

  dispose(ctx) {
    STATES.delete(ctx);
  },
};
