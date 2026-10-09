// Space Invaders for the LED wall (6 m x 2 m, 1008 x 336 LEDs), seen from above like a strategy map
// (Civilization): the wall shows the floor in front of it. x is where people stand along the wall
// (from the wall core: mirrored, the walk stretched over the whole wall), y is how far they stand from
// the wall (default: closer to the wall = higher up on the map). Every person is a unit on the map:
// their body seen from above (from the masks, exact every frame), head and hands as bright points.
//
// Invader formations come from the left and from the right edge and march towards the city in the
// middle. The controls rest on what the tracking does well, where people stand (see game.js):
// automatic fire, standing still fortifies, a laser between two people, jumping and landing sends a
// shock wave, pointing with an arm locks on. A director scales every wave to the crowd and to how
// well it does; the city can fall. No text on the wall: everybody finds it out by trying.
//
// Files: body.js (bodies from the masks), game.js (rules, director), draw.js (the pixel layer and its
// lights), render.js (WebGPU: lit floor, bloom, ripples; moiré-safe for the LED wall), fx.js
// (effects), pixels.js (sprites), sound.js.

import { Game } from './game.js';
import { Bodies } from './body.js';
import { FX } from './fx.js';
import { Pix, ARM, rgb } from './pixels.js';
import { drawArt, collectLights, looks, WHITE } from './draw.js';
import { createRenderer, MAX_LIGHTS } from './render.js';
import { Sound } from './sound.js';

// players: cool colors; the invaders are the warm ones (magenta, red, purple), bullets orange
const PALETTE = ['#29e6ff', '#4d8dff', '#3dffc0', '#b59bff', '#a8e6ff', '#00c2b8', '#7ab8ff', '#e0f4ff', '#6f7dff', '#5ff7e0'].map(rgb);
const INVADER_COLORS = {
  neon: { squid: rgb('#ff3df0'), crab: rgb('#ff4d7d'), octopus: rgb('#b45cff') },
  weiß: { squid: WHITE, crab: WHITE, octopus: WHITE },
};

const slotColor = (s) => (s ? PALETTE[(s - 1) % PALETTE.length] : WHITE);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// state per instance (ctx): the output window may run this scene twice at once
const STATES = new WeakMap();
// the render cap of the param `fps` (read by the runtime every frame through maxFps below)
let fpsCap = 0;

/** the map: art pixel grid on the LED image, wall m -> art px */
export function makeLayout(ctx, p) {
  const wall = ctx.wall;
  const s = wall.setup;
  const W = ctx.width;
  const H = ctx.height;
  const S = Math.max(1, Math.round((p.pixelCm / 100) * wall.pxPerM[0]));
  const AW = Math.max(40, Math.floor(W / S));
  const AH = Math.max(20, Math.floor(H / S));
  const sx = AW / s.size.w;
  // the map's depth: the projection's play field (control center: tab Projektion), a little more on
  // both sides; its depth curve moves the people (a body keeps its shape around its center)
  const F = wall.projection.field;
  const zTop = Math.max(0, F.near - 0.25);
  const zBot = F.far + 0.1;
  const sy = AH / Math.max(0.5, zBot - zTop);
  /** m in front of the wall -> the same through the depth curve (identity while it is linear) */
  const curved = (z) => F.near + wall.fieldZ(z) * (F.far - F.near);
  const up = p.orient !== 'zur Wand = unten';
  const cityW = clamp(Math.round(p.cityWidth * sx), 12, AW - 60);
  const cityX0 = Math.round((s.size.w / 2 + s.sensor.x) * sx - cityW / 2);
  return {
    W,
    H,
    S,
    AW,
    AH,
    ox: Math.floor((W - AW * S) / 2),
    oy: Math.floor((H - AH * S) / 2),
    sx,
    sy,
    zTop,
    zBot,
    up,
    wallFace: up ? -Math.PI / 2 : Math.PI / 2, // facing the wall (rad on the map)
    cityW,
    cityX0,
    gameKey: [W, H, S, AW, AH, cityW, cityX0].join(),
    fogKey: [AW, AH, up, wall.version, p.fog].join(),
    /** wall x (m from the left edge), z (m in front of the wall) -> art px */
    map(x, z) {
      const c = curved(z);
      return [x * sx, up ? (c - zTop) * sy : (zBot - c) * sy];
    },
    /** art row -> m in front of the wall */
    rowZ(y) {
      const c = up ? zTop + y / sy : zBot - y / sy;
      return wall.fieldDepth((c - F.near) / (F.far - F.near));
    },
  };
}

/** where people can be: the sensor's view (a wedge) on the map, a bit wider for the arms; the rest is fog */
function fogMask(ctx, L, p) {
  const wall = ctx.wall;
  const s = wall.setup;
  const P = wall.projection;
  const mask = new Uint8Array(L.AW * L.AH);
  if (!p.fog) return mask.fill(255);
  const cx = s.size.w / 2 + s.sensor.x;
  for (let y = 0; y < L.AH; y++) {
    const z = L.rowZ(y + 0.5); // m in front of the wall
    if (z < P.zone.near - 0.15 || z > P.zone.far + 0.15) continue;
    // the edges of the view there, through the projection
    const half = Math.max(0, (z - s.sensor.front) * wall.tanH);
    const el = wall.mapX(cx - half, z);
    const er = wall.mapX(cx + half, z);
    let xl = Math.min(el, er) - 0.35;
    let xr = Math.max(el, er) + 0.35;
    if (xl < P.margin + 0.2) xl = 0;
    if (xr > s.size.w - P.margin - 0.2) xr = s.size.w;
    const a = Math.max(0, Math.floor(xl * L.sx));
    const b = Math.min(L.AW, Math.ceil(xr * L.sx));
    mask.fill(255, y * L.AW + a, y * L.AW + b);
  }
  return mask;
}

/** the people for the game: from the masks (body.js), plus test players and the mouse */
function collectPeople(ctx, S, p) {
  const L = S.layout;
  const body = S.body;
  body.update(ctx, L, p, S.fx.time); // real time: slow motion must not change the jump velocities
  const people = body.persons.map((b) => ({ id: b.id, slot: b.slot, col: slotColor(b.slot), center: b.center, arms: b.arms, stomp: b.stomp, head: b.head, hands: b.hands, face: b.face }));

  // test players (headless tests, see globalThis.__invaders): { x, z (m), arms: 'L' | 'R' | 'LR', stomp,
  // turn (degrees, + = to the right as seen from above) }
  const stampBody = (gx, gy, slot, arms) => {
    const rx = 0.2 * L.sx * p.bodyScale;
    const ry = 0.08 * L.sy * p.bodyScale;
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) if ((x / rx) ** 2 + (y / ry) ** 2 <= 1) body.stamp(gx + x, gy + y, slot, 1, 130 + 30 * (1 - Math.abs(x / rx)));
    for (const a of arms) {
      const n = Math.ceil(Math.hypot(a.tip[0] - gx, a.tip[1] - gy));
      for (let k = Math.ceil(rx * 0.8); k <= n; k++) body.stamp(gx + (a.tip[0] - gx) * (k / n), gy + (a.tip[1] - gy) * (k / n), slot, 2, 140);
    }
  };
  for (const f of S.fake) {
    const [gx, gy] = L.map(f.x, f.z);
    const slot = f.slot ?? 1;
    const arms = [];
    const face = L.wallFace + (((f.turn ?? 0) * Math.PI) / 180) * (L.up ? 1 : -1);
    const fig = p.look !== 'Silhouette';
    // the arms stretched out sideways from the turned shoulders
    const [rx, ry] = [-Math.sin(face) * (L.up ? 1 : -1), Math.cos(face) * (L.up ? 1 : -1)];
    for (const [k, sd] of [['L', -1], ['R', 1]]) {
      if (!f.arms?.includes(k)) continue;
      const from = fig ? [gx + sd * ARM.shoulder * rx, gy + sd * ARM.shoulder * ry] : [gx, gy];
      const reach = fig ? ARM.reach : 0.75 * L.sx * p.bodyScale;
      arms.push({ id: `${f.id}${k}`, from, tip: [from[0] + sd * reach * rx, from[1] + sd * reach * ry], dir: [sd * rx, sd * ry] });
    }
    if (fig) body.stampFigure({ center: [gx, gy], face, arms, slot }, L, p);
    else stampBody(gx, gy, slot, arms);
    const hw = 0.24 * L.sx * p.bodyScale;
    const hands = [arms.find((a) => a.id.endsWith('L'))?.tip ?? [gx - hw, gy + 1], arms.find((a) => a.id.endsWith('R'))?.tip ?? [gx + hw, gy + 1]];
    people.push({ id: `fake${f.id ?? 0}`, slot, col: slotColor(slot), center: [gx, gy], arms, stomp: !!f.stomp, head: [gx, gy - 1], hands, face });
    f.stomp = false;
  }
  // the mouse (testing without people): a unit where the button is held, it points away from the city
  const wp = ctx.wall.pointer;
  if (wp.down && wp.inside) {
    const x = (wp.x / ctx.wall.setup.size.w) * L.AW;
    const y = wp.v * L.AH;
    const dir = x < L.cityX0 + L.cityW / 2 ? -1 : 1;
    const arms = [{ id: 'mouse', from: [x + dir * ARM.shoulder, y], tip: [x + dir * (ARM.shoulder + ARM.reach), y], dir: [dir, 0] }];
    stampBody(x, y, 16, arms);
    people.push({ id: 'mouse', slot: 16, col: WHITE, center: [x, y], arms, stomp: false, head: [x, y], hands: [arms[0].tip, null], face: L.wallFace });
  }
  return people;
}

export default {
  wall: true, // the canvas is the LED image; wall size, Kinect, zone and mapping: control center
  // seen from above: a box (straight walks stay straight on the map, footprints line up), 2.9 m of
  // floor across the wall (×2), 0.5-4 m from the sensor as the map's depth; steadier units (forts)
  projection: { field: { depth: [0.5, 4], width: 2.9 }, smoothing: 0.25 },
  streams: ['persons'],
  // live masks for the bodies; live + exact skeletons (param exactSlow): body.js takes a joint from the
  // exact skeleton while it moves slowly and from the live one when it is fast
  persons: (p) => (p.exactSlow ? { mode: 'full', live: true } : { mode: 'full', delay: 0 }),
  // 30 fps (param `fps`): the whole frame (tracking analysis, game, drawing) only every second display
  // frame, which leaves CPU and GPU time to the person tracker and the Kinect's depth decoding
  get maxFps() {
    return fpsCap;
  },

  params: {
    control: { value: 'Automatik + Zeigen', options: ['Automatik + Zeigen', 'Automatik', 'Zeigen'], label: 'Steuerung', folder: 'Steuerung' },
    autoEvery: { value: 0.6, min: 0.1, max: 3, step: 0.05, label: 'Automatik: Schuss alle … s (Fort)', folder: 'Steuerung' },
    autoRange: { value: 2, min: 0.5, max: 6, step: 0.1, label: 'Automatik: Reichweite (m)', folder: 'Steuerung' },
    fortify: { value: true, label: 'Stillstehen = Fort (schneller)', folder: 'Steuerung' },
    fortifyAfter: { value: 0.8, min: 0.2, max: 4, step: 0.1, label: 'Fort nach … s still', folder: 'Steuerung' },
    stillSpeed: { value: 0.3, min: 0.05, max: 1, step: 0.01, label: 'Still unter (m/s)', folder: 'Steuerung' },
    links: { value: true, label: 'Team-Laser zwischen Spielern', folder: 'Steuerung' },
    linkMax: { value: 2.5, min: 0.5, max: 6, step: 0.1, label: 'Team-Laser bis (m)', folder: 'Steuerung' },
    linkCooldown: { value: 0.6, min: 0, max: 3, step: 0.05, label: 'Team-Laser: Pause nach Treffer (s)', folder: 'Steuerung' },
    pointEvery: { value: 0.2, min: 0.05, max: 1, step: 0.01, label: 'Zeigen: Schuss alle … s', folder: 'Steuerung' },
    assist: { value: 28, min: 0, max: 60, step: 1, label: 'Zeigen: Zielhilfe (Grad)', folder: 'Steuerung' },
    armMin: { value: 0.33, min: 0.2, max: 0.6, step: 0.01, label: 'Zeigen: Arm ab (m vom Körper)', folder: 'Steuerung' },
    mirrorArm: { value: true, label: 'Verdeckten Arm ergänzen (gespiegelt)', folder: 'Steuerung' },
    armSource: { value: 'Skelett', options: ['Skelett', 'Maske'], label: 'Arme aus', folder: 'Steuerung' },
    exactSlow: { value: true, label: 'Skelett: langsam exakt, schnell live', folder: 'Steuerung' },
    exactBelow: { value: 0.35, min: 0, max: 2, step: 0.05, label: 'Exakt unter (m/s)', folder: 'Steuerung' },
    liveAbove: { value: 0.9, min: 0.1, max: 3, step: 0.05, label: 'Live über (m/s)', folder: 'Steuerung' },
    homing: { value: 5, min: 0, max: 20, step: 0.5, label: 'Schüsse lenken nach (rad/s)', folder: 'Steuerung' },
    bodyScale: { value: 0.6, min: 0.3, max: 1, step: 0.05, label: 'Personen-Größe', folder: 'Steuerung' },
    look: { value: 'Figur', options: ['Figur', 'Silhouette'], label: 'Personen als', folder: 'Karte' },
    turn: { value: true, label: 'Figuren drehen sich mit (Schultern)', folder: 'Karte' },
    stepLen: { value: 0.35, min: 0.15, max: 1, step: 0.05, label: 'Fußspur alle … m', folder: 'Karte' },
    footLife: { value: 5, min: 0.5, max: 20, step: 0.5, label: 'Fußspuren bleiben (s)', folder: 'Karte' },
    jumpBoost: { value: true, label: 'Springen = Boost', folder: 'Steuerung' },
    jumpHint: { value: 'bis zum ersten Boost', options: ['bis zum ersten Boost', 'immer', 'aus'], label: 'Sprung-Hinweis (Männchen)', folder: 'Steuerung' },
    boostTime: { value: 5, min: 1, max: 20, step: 0.5, label: 'Boost hält (s)', folder: 'Steuerung' },
    boostRecharge: { value: 12, min: 2, max: 60, step: 1, label: 'Boost lädt auf (s)', folder: 'Steuerung' },
    boostFire: { value: 2.5, min: 1, max: 6, step: 0.1, label: 'Boost: Feuer schneller (×)', folder: 'Steuerung' },
    boostDamage: { value: 2, min: 1, max: 5, step: 1, label: 'Boost: Schaden pro Schuss', folder: 'Steuerung' },
    jumpVy: { value: 0.45, min: 0.15, max: 1.5, step: 0.01, label: 'Sprung: Körper steigt schneller als (m/s)', folder: 'Steuerung' },
    jumpVy2: { value: 0.35, min: 0, max: 1.5, step: 0.01, label: 'Sprung: und das Becken schneller als (m/s)', folder: 'Steuerung' },
    jumpRise: { value: 0.05, min: 0.01, max: 0.25, step: 0.005, label: 'Sprung: würde so hoch fliegen (m)', folder: 'Steuerung' },
    jumpDip: { value: 0.1, min: 0, max: 0.4, step: 0.01, label: 'Sprung: darf so tief beginnen (m)', folder: 'Steuerung' },
    walkGate: { value: 0.55, min: 0.1, max: 3, step: 0.05, label: 'Sprung: nicht beim Gehen über (m/s)', folder: 'Steuerung' },

    targetTime: { value: 40, min: 10, max: 180, step: 5, label: 'Ziel-Dauer einer Welle (s)', folder: 'Balance' },
    cityFall: { value: 0.25, min: 0, max: 0.8, step: 0.01, label: 'Stadt fällt unter (Anteil)', folder: 'Balance' },
    rows: { value: 4, min: 1, max: 8, step: 1, label: 'Reihen pro Seite (1 Person)', folder: 'Balance' },
    cols: { value: 3, min: 1, max: 6, step: 1, label: 'Spalten pro Seite (1 Person)', folder: 'Balance' },
    speed: { value: 1, min: 0.2, max: 3, step: 0.05, label: 'Tempo', folder: 'Balance' },
    advance: { value: 8, min: 1, max: 24, step: 1, label: 'Vorrücken pro Wende (Pixel)', folder: 'Balance' },
    enemyFire: { value: 1, min: 0, max: 4, step: 0.05, label: 'Beschuss', folder: 'Balance' },
    dive: { value: 1, min: 0, max: 4, step: 0.05, label: 'Sturzflieger', folder: 'Balance' },
    diveSpeed: { value: 1.6, min: 0.5, max: 4, step: 0.05, label: 'Sturzflieger (m/s)', folder: 'Balance' },
    bulletSpeed: { value: 1.3, min: 0.3, max: 4, step: 0.05, label: 'Gegnerschüsse (m/s)', folder: 'Balance' },
    laserSpeed: { value: 5, min: 1, max: 15, step: 0.5, label: 'Laser (m/s)', folder: 'Balance' },
    stun: { value: 1, min: 0, max: 5, step: 0.1, label: 'Getroffen: Pause (s)', folder: 'Balance' },
    ufoEvery: { value: 30, min: 5, max: 120, step: 1, label: 'Mutterschiff alle … s', folder: 'Balance' },
    telegraph: { value: 0.35, min: 0, max: 1.5, step: 0.05, label: 'Vorwarnung vor Schüssen (s)', folder: 'Balance' },
    bombs: { value: 1, min: 0, max: 4, step: 0.05, label: 'Minen', folder: 'Balance' },
    bombFuse: { value: 1.4, min: 0.4, max: 4, step: 0.1, label: 'Minen: Zünder (s)', folder: 'Balance' },
    ship: { value: true, label: 'Schlachtschiff', folder: 'Balance' },
    shipFrom: { value: 2, min: 1, max: 10, step: 1, label: 'Schlachtschiff ab Welle', folder: 'Balance' },
    shipFirst: { value: 18, min: 3, max: 120, step: 1, label: 'Schlachtschiff nach … s der Welle', folder: 'Balance' },
    shipEvery: { value: 40, min: 10, max: 180, step: 5, label: 'Schlachtschiff wieder nach … s', folder: 'Balance' },
    shipHp: { value: 30, min: 5, max: 200, step: 5, label: 'Schlachtschiff: Treffer (1 Person)', folder: 'Balance' },
    shipCharge: { value: 1.5, min: 0.5, max: 4, step: 0.1, label: 'Schlachtschiff: Laden (s)', folder: 'Balance' },
    beamWidth: { value: 0.55, min: 0.2, max: 1.5, step: 0.05, label: 'Laser breit (m)', folder: 'Balance' },
    edgeLasers: { value: 1, min: 0, max: 4, step: 0.05, label: 'Laser vom Rand', folder: 'Balance' },
    edgeFrom: { value: 2, min: 1, max: 10, step: 1, label: 'Laser vom Rand ab Welle', folder: 'Balance' },
    edgeWidth: { value: 0.3, min: 0.1, max: 1, step: 0.05, label: 'Laser vom Rand: breit (m)', folder: 'Balance' },
    edgeTele: { value: 1.3, min: 0.4, max: 3, step: 0.1, label: 'Laser vom Rand: Vorwarnung (s)', folder: 'Balance' },
    items: { value: true, label: 'Powerups', folder: 'Balance' },
    itemEvery: { value: 16, min: 3, max: 60, step: 1, label: 'Powerup alle … s (1 Person)', folder: 'Balance' },
    powerTime: { value: 8, min: 2, max: 20, step: 0.5, label: 'Powerups wirken (s)', folder: 'Balance' },
    resetAfter: { value: 10, min: 2, max: 60, step: 1, label: 'Neue Runde nach (s leer)', folder: 'Balance' },

    orient: { value: 'zur Wand = oben', options: ['zur Wand = oben', 'zur Wand = unten'], label: 'Karte', folder: 'Karte' },
    pixelCm: { value: 2.4, min: 1.2, max: 4, step: 0.1, label: 'Pixelgröße (cm)', folder: 'Karte' },
    cityWidth: { value: 0.6, min: 0.2, max: 2, step: 0.05, label: 'Stadt breit (m)', folder: 'Karte' },
    hex: { value: 1, min: 0, max: 3, step: 0.05, label: 'Hex-Raster', folder: 'Karte' },
    fog: { value: true, label: 'Raster nur wo die Kinect sieht', folder: 'Karte' },

    colors: { value: 'neon', options: ['neon', 'weiß'], label: 'Invader', folder: 'Bild' },
    bloom: { value: 0.9, min: 0, max: 3, step: 0.05, label: 'Leuchten', folder: 'Bild' },
    bloomWide: { value: 0.6, min: 0, max: 3, step: 0.05, label: 'Leuchten weit', folder: 'Bild' },
    lights: { value: 1, min: 0, max: 3, step: 0.05, label: 'Licht auf dem Boden', folder: 'Bild' },
    shake: { value: 1, min: 0, max: 3, step: 0.1, label: 'Wackeln', folder: 'Bild' },
    chroma: { value: 1, min: 0, max: 3, step: 0.1, label: 'Farbsaum bei Treffern', folder: 'Bild' },
    flash: { value: 1, min: 0, max: 2, step: 0.05, label: 'Blitze', folder: 'Bild' },
    slowmo: { value: true, label: 'Zeitlupe bei großen Momenten', folder: 'Bild' },
    brightness: { value: 1, min: 0.2, max: 1.5, step: 0.05, label: 'Helligkeit', folder: 'Bild' },
    fps: { value: '30', options: ['30', '60'], label: 'Bildrate (30 = mehr Luft fürs Tracking)', folder: 'Bild' },
    sound: { value: true, label: 'Ton', folder: 'Bild' },
    volume: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Lautstärke', folder: 'Bild' },
  },

  async setup(ctx) {
    const renderer = await createRenderer(ctx);
    const sound = new Sound();
    const unlock = () => ctx.params.sound && sound.unlock();
    ctx.on(window, 'pointerdown', unlock);
    ctx.on(window, 'keydown', unlock);
    unlock(); // works right away in a kiosk browser that allows autoplay
    const fx = new FX();
    const S = {
      renderer,
      fx,
      pix: new Pix(8, 8),
      body: new Bodies(),
      game: new Game(fx),
      sound,
      lights: new Float32Array(MAX_LIGHTS * 8),
      layout: null,
      gameKey: '',
      fogKey: '',
      fake: [],
      people: [],
      invCol: null,
      destroy() {
        sound.stopAll();
        renderer.destroy();
      },
    };
    ctx.track(S);
    STATES.set(ctx, S);
    // for debugging and tests
    globalThis.__invaders = {
      game: S.game,
      body: S.body,
      fx,
      fake: S.fake,
      params: ctx.params,
      ctx,
      get ms() {
        return S.ms;
      },
      get people() {
        return S.people;
      },
    };
  },

  frame(ctx) {
    const S = STATES.get(ctx);
    if (!S) return;
    const t0 = performance.now();
    const p = ctx.params;
    fpsCap = p.fps === '30' ? 30 : 0;
    const L = (S.layout = makeLayout(ctx, p));
    if (L.gameKey !== S.gameKey) {
      S.gameKey = L.gameKey;
      S.pix.resize(L.W, L.H, L.S, L.ox, L.oy);
      S.body.resize(L.AW, L.AH);
      S.game.setLayout(L);
      S.fogKey = '';
    }
    if (L.fogKey !== S.fogKey) {
      S.fogKey = L.fogKey;
      const mask = fogMask(ctx, L, p);
      S.renderer.setFog(L, mask);
      S.game.reach = mask; // power-ups only where people can get to
    }
    const colors = INVADER_COLORS[p.colors] ?? INVADER_COLORS.neon;
    S.invCol = (type) => colors[type] ?? WHITE;

    const dt = Math.min(Math.max(ctx.dt, 0.001), 1 / 15);
    const fx = S.fx;
    fx.step(dt);
    if (!p.slowmo) fx.slowUntil = 0;
    const people = (S.people = collectPeople(ctx, S, p));
    const t1 = performance.now();
    const game = S.game;
    game.step(dt, people, S.body, p, S.invCol);
    // the show switches between waves (WALL.md, "Games: switch between rounds"): not while people fight
    // one (a tracking gap of a moment does not count as gone), only after the first fireworks of a
    // cleared wave or once the fallen city has crumbled
    const ph = game.phase;
    ctx.holdSwitch = (game.emptyFor < 2 && (ph === 'enter' || ph === 'fight')) || (ph === 'clear' && game.phaseT < 1.5) || (ph === 'fall' && game.phaseT < 2.5);
    const t2 = performance.now();
    if (p.sound) {
      S.sound.setVolume(p.volume);
      for (const e of game.events) S.sound.play(e, L.AW);
    } else S.sound.stopAll();
    game.events.length = 0;

    S.P = p;
    const look = looks(game, people);
    drawArt(S, people, look);
    const nLights = collectLights(S, people, look, S.lights);
    for (let i = 0; i < nLights; i++) S.lights[i * 8 + 3] *= p.lights;
    const t3 = performance.now();
    // ripples in LED pixels
    const pxm = L.sx * L.S;
    const ripples = fx.ripples.map((r) => {
      const u = (fx.time - r.t0) / r.life;
      return [L.ox + r.x * L.S, L.oy + r.y * L.S, r.speed * (fx.time - r.t0) * pxm, r.amp * (1 - u) ** 2];
    });
    const k = fx.shake * p.shake;
    const shake = k > 0.3 ? [Math.round((Math.random() * 2 - 1) * k * 1.5), Math.round((Math.random() * 2 - 1) * k)] : [0, 0];
    S.renderer.render({
      L,
      art: S.pix.buf,
      lights: S.lights,
      nLights,
      ripples,
      shake,
      flash: [...fx.flashCol, fx.flashAmt * p.flash],
      chroma: fx.chroma * p.chroma,
      pulse: fx.pulse,
      hex: p.hex,
      bloom: p.bloom,
      bloomWide: p.bloomWide,
      brightness: p.brightness,
      time: game.time,
    });
    // main-thread time per frame (ms, smoothed): the tracker's workers and the pose model share the machine
    const t4 = performance.now();
    const ms = (S.ms ??= { body: 0, game: 0, draw: 0, render: 0, total: 0 });
    for (const [key, v] of [['body', t1 - t0], ['game', t2 - t1], ['draw', t3 - t2], ['render', t4 - t3], ['total', t4 - t0]]) ms[key] += (v - ms[key]) * 0.05;

    const alive = game.sides.reduce((n, s) => n + s.count, 0);
    const arms = people.reduce((n, q) => n + q.arms.length, 0);
    const snd = p.sound && !S.sound.ready ? ' · Ton: einmal klicken' : '';
    ctx.status = `${people.length} Spieler (${arms} Arme) · Welle ${game.level} · Skill ${game.skill.toFixed(2)} · ${alive} Invader + ${game.divers.length} Flieger${game.ship ? ` · Schiff ${game.ship.state} ${game.ship.hp}/${game.ship.hpMax}` : ''} · Stadt ${Math.round(game.cityHealth * 100)} % · ${game.phase} · ${game.score} Punkte${snd}`;
  },

  dispose(ctx) {
    STATES.get(ctx)?.sound.stopAll();
    STATES.delete(ctx);
  },
};
