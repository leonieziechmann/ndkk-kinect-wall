// Cyberspiegel: the LED wall (6 m x 2 m, 1008 x 336) as a dark mirror into cyberspace.
//
// Only the people come from the Kinect: their mask pixels (person tracking, delayed mode: exact
// skeletons) become point clouds like the three.js particles, at their mirrored place. Everything
// else is virtual and made of particles too: an arena of heaving particle walls (Blackwall) with a
// glowing tear of light in the middle, dunes of dots, flickering streaks, drifting motes.
//
// The wall is the mirror plane: a camera at the viewer's place looks through the wall rectangle
// (off-axis frustum) into the mirrored world, whose floor continues the real floor at the bottom
// edge of the wall. Step closer and you grow, step aside and your image follows, like in a mirror.
//
// Things to try, without any hint on the wall (interact.js reads them from the skeletons):
//   hands and feet stir a swarm of particles in the air     jump: a quake runs through the floor
//   both arms up and held: energy gathers, a pillar of light  arms spread: the Blackwall opens
//   clap: a shock wave                                        stand still: you upload into the core
//   two people's hands close: a crackling arc                 close to the wall: the mirror cracks
// And everyone hangs on marionette strings (head and hands) from a puppeteer above (strings.js).
//
// Rendering (three.js WebGPURenderer): the scene at LED resolution x supersampling -> bloom, RGB
// split, glitches at LED resolution -> the LED image (1008 x 336) -> the canvas: scaled to fit
// ("Vorschau") or one LED per canvas pixel at the top left ("LED pixelgenau", for the LED controller).
//
// Files: world.js (the surroundings), people.js (the person point clouds), fx.js (particles, swarm),
// interact.js (gestures), strings.js (marionette strings).

import * as THREE from 'three/webgpu';
import { Fn, abs, exp, float, floor, hash, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createWorld, MAX_MARKS, MAX_QUAKES, mulberry } from './world.js';
import { createPeople } from './people.js';
import { Sparks, Swarm } from './fx.js';
import { createInteractions } from './interact.js';
import { createStrings } from './strings.js';

const FACE = ['leftEye', 'rightEye'];
const HANDS = ['leftHand', 'rightHand'];
const MOVERS = ['leftHand', 'rightHand', 'leftAnkle', 'rightAnkle']; // what stirs the swarm
const CORE = [0, 9, -68]; // the glowing core in the mirror world (uploads fly there)

let S = null; // everything setup() creates

/** A camera whose frustum goes exactly through the wall rectangle (`frustum` = l, r, t, b at distance 1). */
class WallCamera extends THREE.PerspectiveCamera {
  constructor() {
    super(50, 3, 0.05, 400);
    this.frustum = [-1, 1, 0.3, -0.3];
    this.updateProjectionMatrix();
  }

  updateProjectionMatrix() {
    if (!this.frustum) return;
    const n = this.near;
    const [l, r, t, b] = this.frustum;
    this.projectionMatrix.makePerspective(l * n, r * n, t * n, b * n, n, this.far, this.coordinateSystem, this.reversedDepth);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

/** World -> room without a found floor: the sensor camH above the floor, tilted down by tiltDeg. */
function manualRoom(camH, tiltDeg) {
  const t = (tiltDeg * Math.PI) / 180;
  const up = [0, Math.cos(t), -Math.sin(t)];
  const fwd = [0, Math.sin(t), Math.cos(t)];
  const m = new Float32Array(16);
  for (let j = 0; j < 3; j++) {
    m[j * 4] = j === 0 ? 1 : 0;
    m[j * 4 + 1] = up[j];
    m[j * 4 + 2] = fwd[j];
  }
  m[13] = camH;
  m[15] = 1;
  return m;
}

/**
 * Coefficients from the Kinect camera frame (m: x right, y down, z forward) to the mirror world:
 * world = (xSign x, -y, z) -> room (matrix M) -> X = camX - room.x, Y = room.y, Z = shift - room.z.
 * X is flipped: with the default xSign (-1) the world's +x is the person's left, and a mirror shows
 * the left side on the left. Key m (xSign) switches to the camera view.
 * For a ray (rx, ry) at depth z: X = z (xf0 rx + xf1 ry + xf2) + xf3, and so on.
 */
function mirrorTransform(M, xSign, camX, shift) {
  return [
    -M[0] * xSign, M[4], -M[8], camX - M[12],
    M[1] * xSign, -M[5], M[9], M[13],
    -M[2] * xSign, M[6], -M[10], shift - M[14],
  ];
}

/** world direction (velocity) -> mirror world */
function dirToMirror(M, v, out = [0, 0, 0]) {
  out[0] = -(M[0] * v[0] + M[4] * v[1] + M[8] * v[2]);
  out[1] = M[1] * v[0] + M[5] * v[1] + M[9] * v[2];
  out[2] = -(M[2] * v[0] + M[6] * v[1] + M[10] * v[2]);
  return out;
}

/** world point (m, as ctx.persons) -> mirror world */
function worldToMirror(M, camX, shift, w, out = [0, 0, 0]) {
  out[0] = camX - (M[0] * w[0] + M[4] * w[1] + M[8] * w[2] + M[12]);
  out[1] = M[1] * w[0] + M[5] * w[1] + M[9] * w[2] + M[13];
  out[2] = shift - (M[2] * w[0] + M[6] * w[1] + M[10] * w[2] + M[14]);
  return out;
}

export default {
  streams: ['persons'], // depth and ir come with it
  persons: { mode: 'full' }, // default delay: exact skeletons; the whole scene shows the same moment
  pixelRatio: 1, // canvas pixels = screen pixels: "LED pixelgenau" is one LED per pixel
  // the pose model and the Kinect's depth decoding share the GPU; the people come at 30 Hz anyway
  // (?fps=60 in the URL for more)
  maxFps: 30,

  params: {
    viewMode: { value: 0, options: { Vorschau: 0, 'LED pixelgenau': 1 }, label: 'Ansicht', folder: 'Wand' },
    ledW: { value: 1008, min: 64, max: 4096, step: 1, label: 'LEDs breit', folder: 'Wand' },
    ledH: { value: 336, min: 32, max: 2048, step: 1, label: 'LEDs hoch', folder: 'Wand' },
    wallW: { value: 6, min: 1, max: 20, step: 0.1, label: 'Wand breit (m)', folder: 'Wand' },
    wallH: { value: 2, min: 0.5, max: 8, step: 0.1, label: 'Wand hoch (m)', folder: 'Wand' },
    wallBottom: { value: 0, min: 0, max: 3, step: 0.05, label: 'Wand Unterkante (m)', folder: 'Wand' },
    camX: { value: 0, min: -10, max: 10, step: 0.05, label: 'Kinect seitlich (m)', folder: 'Wand' },
    front: { value: 0.1, min: 0, max: 3, step: 0.05, label: 'Kinect vor der Wand (m)', folder: 'Wand' },
    camH: { value: 0.85, min: 0, max: 4, step: 0.05, label: 'Kinect-Höhe ohne Boden (m)', folder: 'Wand' },
    camTilt: { value: 0, min: -45, max: 45, step: 0.5, label: 'Neigung ohne Boden (°)', folder: 'Wand' },
    ss: { value: 2, options: { '1×': 1, '2×': 2, '3×': 3 }, label: 'Supersampling', folder: 'Wand' },

    eyeDist: { value: 3, min: 0.8, max: 10, step: 0.05, label: 'Blickpunkt vor der Wand (m)', folder: 'Spiegel' },
    eyeH: { value: 1.1, min: 0.3, max: 3, step: 0.01, label: 'Augenhöhe (m)', folder: 'Spiegel' },
    pull: { value: 1.2, min: 0, max: 3, step: 0.05, label: 'Spiegelbild näher (m)', folder: 'Spiegel' },
    follow: { value: 0.25, min: 0, max: 1, step: 0.01, label: 'Parallaxe (folgt den Personen)', folder: 'Spiegel' },

    density: { value: 3, options: { 'jedes Pixel': 1, 'jedes 2.': 2, 'jedes 3.': 3 }, label: 'Punktdichte', folder: 'Personen' },
    dotSize: { value: 1.25, min: 0.5, max: 4, step: 0.05, label: 'Punktgröße (LEDs)', folder: 'Personen' },
    nearColor: { value: '#ff2d6a', label: 'Farbe nah', folder: 'Personen' },
    farColor: { value: '#3d4bff', label: 'Farbe fern', folder: 'Personen' },
    nearDist: { value: 1.5, min: 0.5, max: 6, step: 0.05, label: 'nah bei (m)', folder: 'Personen' },
    farDist: { value: 4, min: 1, max: 8, step: 0.05, label: 'fern bei (m)', folder: 'Personen' },
    gain: { value: 1.8, min: 0, max: 4, step: 0.01, label: 'Helligkeit', folder: 'Personen' },
    irGain: { value: 0.9, min: 0, max: 2, step: 0.01, label: 'IR-Helligkeit', folder: 'Personen' },
    rim: { value: 1, min: 0, max: 3, step: 0.01, label: 'Kontur', folder: 'Personen' },
    occlude: { value: true, label: 'Dunkler Körper', folder: 'Personen' },
    body: { value: '#050308', label: 'Körperfarbe', folder: 'Personen' },
    eyes: { value: 0.6, min: 0, max: 3, step: 0.01, label: 'Augen leuchten', folder: 'Personen' },
    glitch: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Glitch', folder: 'Personen' },
    reveal: { value: 1.8, min: 0.3, max: 10, step: 0.1, label: 'Einscannen (m/s)', folder: 'Personen' },

    dust: { value: 1, min: 0, max: 4, step: 0.01, label: 'Zerstäuben', folder: 'Partikel' },
    wind: { value: 0.6, min: -2, max: 2, step: 0.01, label: 'Wind', folder: 'Partikel' },
    trails: { value: 1, min: 0, max: 4, step: 0.01, label: 'Handspuren', folder: 'Partikel' },
    burst: { value: 1, min: 0, max: 3, step: 0.01, label: 'Zerfallen beim Gehen', folder: 'Partikel' },

    strings: { value: 1, min: 0, max: 3, step: 0.01, label: 'Fäden', folder: 'Marionette' },
    stringTarget: { value: 'up', options: { 'nach oben (Puppenspieler)': 'up', 'zum Kern der Blackwall': 'core' }, label: 'Fäden führen', folder: 'Marionette' },
    stringColor: { value: '#ffe0ee', label: 'Farbe der Fäden', folder: 'Marionette' },
    swing: { value: 1, min: 0, max: 3, step: 0.01, label: 'Schwingen', folder: 'Marionette' },

    swarm: { value: 1, min: 0, max: 3, step: 0.01, label: 'Schwarm (Hände, Füße)', folder: 'Interaktion' },
    quake: { value: 1, min: 0, max: 2, step: 0.01, label: 'Springen: Erdbeben', folder: 'Interaktion' },
    shake: { value: 1, min: 0, max: 3, step: 0.01, label: 'Bild wackelt', folder: 'Interaktion' },
    charge: { value: 1, min: 0, max: 2, step: 0.01, label: 'Arme hoch: Lichtsäule', folder: 'Interaktion' },
    open: { value: 1, min: 0, max: 2, step: 0.01, label: 'Arme ausbreiten: Wand öffnet sich', folder: 'Interaktion' },
    clap: { value: 1, min: 0, max: 2, step: 0.01, label: 'Klatschen: Druckwelle', folder: 'Interaktion' },
    upload: { value: 1, min: 0, max: 1, step: 0.01, label: 'Stillstehen: Hochladen', folder: 'Interaktion' },
    arcs: { value: 1, min: 0, max: 2, step: 0.01, label: 'Hände zweier Personen: Lichtbogen', folder: 'Interaktion' },
    near: { value: 1, min: 0, max: 2, step: 0.01, label: 'Nah an der Wand: Risse', folder: 'Interaktion' },

    wall: { value: 1, min: 0, max: 3, step: 0.01, label: 'Blackwall', folder: 'Welt' },
    core: { value: 1, min: 0, max: 3, step: 0.01, label: 'Kern', folder: 'Welt' },
    glow: { value: 1, min: 0, max: 3, step: 0.01, label: 'Rotes Glühen', folder: 'Welt' },
    floor: { value: 1, min: 0, max: 3, step: 0.01, label: 'Boden', folder: 'Welt' },
    ripples: { value: 1, min: 0, max: 3, step: 0.01, label: 'Wellen um die Füße', folder: 'Welt' },
    streaks: { value: 1, min: 0, max: 3, step: 0.01, label: 'Lichtstreifen', folder: 'Welt' },
    motes: { value: 1, min: 0, max: 3, step: 0.01, label: 'Schwebeteilchen', folder: 'Welt' },
    red: { value: '#ff1e3c', label: 'Rot', folder: 'Welt' },
    pink: { value: '#ff3fa6', label: 'Pink', folder: 'Welt' },
    blue: { value: '#3b4bff', label: 'Blau', folder: 'Welt' },

    bloom: { value: 0.8, min: 0, max: 3, step: 0.01, label: 'Bloom', folder: 'Bild' },
    bloomRadius: { value: 0.4, min: 0, max: 1, step: 0.01, label: 'Bloom-Radius', folder: 'Bild' },
    bloomThreshold: { value: 0.3, min: 0, max: 2, step: 0.01, label: 'Bloom-Schwelle', folder: 'Bild' },
    chroma: { value: 0.35, min: 0, max: 6, step: 0.05, label: 'RGB-Versatz (LEDs)', folder: 'Bild' },
    glitchImage: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Bild-Glitch', folder: 'Bild' },
    vignette: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'Vignette', folder: 'Bild' },
    exposure: { value: 1.5, min: 0.2, max: 4, step: 0.01, label: 'Belichtung', folder: 'Bild' },
  },

  async setup(ctx) {
    const renderer = new THREE.WebGPURenderer({ canvas: ctx.canvas, antialias: false });
    await renderer.init();
    renderer.setPixelRatio(1); // ctx.width/height are device pixels already
    renderer.setSize(ctx.width, ctx.height, false);
    renderer.setClearColor(0x000000, 1);

    const scene = new THREE.Scene();
    const camera = new WallCamera();
    const world = createWorld();
    const people = createPeople();
    const sparks = new Sparks(16000, 4000);
    const swarm = new Swarm(2600);
    scene.add(world.group, people.body, people.dots, swarm.sprite, sparks.sprite);

    // post: scene (supersampled) -> bloom, RGB split, glitch at LED resolution -> LED image -> canvas
    const post = {
      exposure: uniform(1.2),
      ca: uniform(0), // RGB split in uv units
      caGlitch: uniform(0),
      slice: uniform(0), // image glitch: amplitude
      seed: uniform(0),
      vignette: uniform(0.35),
      flash: uniform(0), // brief brightening (claps, eruptions)
    };
    const sceneTex = texture(new THREE.Texture());
    const bloomNode = bloom(sceneTex, 0.8, 0.4, 0.3);
    // the bloom follows the LED image, not the size of the canvas
    const setSize = bloomNode.setSize.bind(bloomNode);
    bloomNode.setSize = () => setSize(S.led.w, S.led.h);
    const ledMat = new THREE.NodeMaterial();
    ledMat.fragmentNode = Fn(() => {
      const q = uv();
      // glitch: bands of rows jump sideways
      const row = floor(q.y.mul(22));
      const on = hash(row.add(post.seed.mul(17))).greaterThan(0.7).select(post.slice, 0);
      const p = vec2(q.x.add(hash(row.add(post.seed.mul(3)).add(1)).sub(0.5).mul(0.08).mul(on)), q.y);
      // RGB split, stronger towards the ends of the wall and in a glitch
      const dx = p.x.sub(0.5);
      const ca = post.ca.mul(abs(dx).mul(1.6).add(0.2)).add(post.caGlitch.mul(on.add(0.3)));
      const r = sceneTex.sample(vec2(p.x.add(ca), p.y)).r;
      const g = sceneTex.sample(p).g;
      const b = sceneTex.sample(vec2(p.x.sub(ca), p.y)).b;
      const c = vec3(r, g, b).add(bloomNode.rgb).mul(post.exposure.mul(post.flash.add(1)));
      const vig = float(1).sub(smoothstep(0.28, 0.5, abs(dx)).mul(post.vignette));
      return vec4(vec3(1).sub(exp(c.negate())).mul(vig), 1); // soft shoulder, black stays black
    })();
    const ledTex = texture(new THREE.Texture());
    const screenMat = new THREE.NodeMaterial();
    screenMat.fragmentNode = vec4(ledTex.sample(uv()).rgb, 1);

    S = {
      renderer,
      scene,
      camera,
      world,
      people,
      sparks,
      swarm,
      interact: createInteractions(),
      strings: createStrings(),
      slack: 0, // the strings go slack in a jump
      stringColor: new THREE.Color(),
      post,
      sceneTex,
      ledTex,
      bloomNode,
      quadLed: new THREE.QuadMesh(ledMat),
      quadScreen: new THREE.QuadMesh(screenMat),
      mats: [ledMat, screenMat],
      led: null, // render targets, see ensureTargets()
      viewKey: '',
      eye: { x: 0 },
      energy: 0,
      marks: new Map(), // person id -> { x, z, alpha, slot, seen }
      idSlot: new Map(),
      hands: new Map(), // `${id}:${hand}` -> last position
      glitch: { next: 2, until: 0, seed: 0, change: 0, image: false },
      lastUpdate: 0,
      nearColor: new THREE.Color(),
      farColor: new THREE.Color(),
      tmp: [0, 0, 0],
      colorAt: null,
      shake: 0, // camera shake 0..1
      flash: 0,
      quakeIndex: 0,
      quakes: [], // { t, s } for the trembling of the wall
      kicks: [], // one-frame pushes for the swarm
      near: 0, // somebody close to the wall, 0..1
      arcs: [],
      lastEvent: '',
      lastEventAt: 0,
    };
    ctx.track({ destroy: () => destroyAll() });
  },

  resize(ctx) {
    S?.renderer.setSize(ctx.width, ctx.height, false);
  },

  frame(ctx) {
    const p = ctx.params;
    const { renderer, camera, world, people, sparks } = S;
    const dt = Math.min(Math.max(ctx.dt, 0.001), 0.1);
    const t = ctx.time;
    const led = ensureTargets(p);

    // ---------- the mirror geometry ----------
    const persons = ctx.persons;
    const roomM = persons.room?.found ? persons.room.matrix : manualRoom(p.camH, p.camTilt);
    const shift = p.pull - p.front;
    const wall = { l: -p.wallW / 2, r: p.wallW / 2, b: p.wallBottom, t: p.wallBottom + p.wallH };
    // parallax: the point of view drifts a little towards the people
    let hx = 0;
    let hn = 0;
    for (const q of persons) {
      if (!q.head) continue;
      hx += worldToMirror(roomM, p.camX, shift, q.head, S.tmp)[0];
      hn++;
    }
    const targetX = hn ? Math.max(wall.l, Math.min(wall.r, (hx / hn) * p.follow)) : 0;
    S.eye.x += (targetX - S.eye.x) * Math.min(1, dt / 1.5);
    const D = p.eyeDist;
    // a quake shakes the point of view
    const sk = S.shake * S.shake * 0.04 * p.shake;
    const ex = S.eye.x + Math.sin(t * 57) * sk;
    const ey = p.eyeH + Math.sin(t * 43 + 1) * sk * 0.7;
    camera.position.set(ex, ey, D);
    camera.frustum = [(wall.l - ex) / D, (wall.r - ex) / D, (wall.t - ey) / D, (wall.b - ey) / D];
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const ledPx = p.wallH / led.h; // m per LED on the wall

    // the world's dots are spaced for the view
    const key = `${p.eyeH}:${D}:${ledPx}:${p.wallW}`;
    if (key !== S.viewKey) {
      S.viewKey = key;
      world.build({ eyeH: p.eyeH, eyeDist: D, ledPx, wallW: p.wallW });
      S.swarm.build({ eyeDist: D, ledPx, wallW: p.wallW }, mulberry(5));
    }

    // ---------- uniforms ----------
    S.nearColor.set(p.nearColor);
    S.farColor.set(p.farColor);
    const span = Math.max(0.1, p.farDist - p.nearDist);
    // color of a point in the mirror world at depth Z (as the people's dots)
    S.colorAt = (Z, out = new THREE.Color()) => out.copy(S.nearColor).lerp(S.farColor, Math.min(1, Math.max(0, (shift - Z + p.front - p.nearDist) / span)));
    const U = people.U;
    U.time.value = t;
    U.near.value.copy(S.nearColor);
    U.far.value.copy(S.farColor);
    U.body.value.set(p.body);
    U.gain.value = p.gain;
    U.irGain.value = p.irGain;
    U.rim.value = p.rim;
    U.reveal.value = p.reveal;
    for (let s = 0; s < 17; s++) U.ages.array[s] = 99;
    for (const q of persons.all) if (q.slot >= 1 && q.slot <= 16) U.ages.array[q.slot] = q.age;
    people.body.visible = p.occlude && people.count > 0;
    updateGlitch(t, p, led);

    const W = world.U;
    W.time.value = t;
    W.floor.value = p.floor;
    W.wall.value = p.wall;
    W.core.value = p.core;
    W.glow.value = p.glow;
    W.streaks.value = p.streaks;
    W.motes.value = p.motes;
    W.red.value.set(p.red);
    W.pink.value.set(p.pink);
    W.blue.value.set(p.blue);
    // the people's motion makes the wall surge
    let move = 0;
    for (const q of persons) for (const h of HANDS) if (q.motion[h]) move += Math.hypot(...q.motion[h]);
    const target = Math.min(1, move / 4);
    S.energy += (target - S.energy) * Math.min(1, dt / (target > S.energy ? 0.4 : 2.5));
    W.energy.value = S.energy;

    // ---------- the people ----------
    const k = ctx.kinect;
    if (k.fresh.persons && k.persons) {
      const xf = mirrorTransform(roomM, ctx.xSign, p.camX, shift);
      people.build(k.persons, k.rays, k.ir?.data ?? null, xf, {
        fx: k.params?.fx ?? 365.5,
        step: Number(p.density) || 3,
        near: p.nearDist,
        far: p.farDist,
        dotLed: p.dotSize * ledPx,
        eyeDist: D,
        front: p.front,
      });
      const since = Math.min(0.1, t - S.lastUpdate || 1 / 30);
      S.lastUpdate = t;
      shedDust(p, since, ledPx);
      handTrails(ctx, p, roomM, shift, since, ledPx);
      leaving(ctx, p, ledPx);
    }
    updateMarks(ctx, p, roomM, shift, dt);

    // ---------- what the people do ----------
    interaction(ctx, p, roomM, shift, ledPx, dt);

    // ---------- particles ----------
    sparks.update(dt, t);
    eyes(ctx, p, roomM, shift, ledPx);
    arcs(p, roomM, shift, ledPx);
    marionette(ctx, p, roomM, shift, ledPx, wall.t, dt);
    sparks.upload();
    swarmStep(ctx, p, roomM, shift, dt);

    // ---------- render ----------
    S.bloomNode.strength.value = p.bloom;
    S.bloomNode.radius.value = p.bloomRadius;
    S.bloomNode.threshold.value = p.bloomThreshold;
    S.post.exposure.value = p.exposure;
    S.post.flash.value = S.flash;
    S.post.ca.value = (p.chroma * (1 + 5 * S.near * p.near)) / led.w;
    S.post.vignette.value = p.vignette;
    renderer.setRenderTarget(led.scene);
    renderer.render(S.scene, camera);
    renderer.setRenderTarget(led.image);
    S.quadLed.render(renderer);
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, ctx.width, ctx.height);
    renderer.clear(); // black around the LED image
    renderer.autoClear = false;
    let rect; // the LED image on the canvas: x, y from the top left, w, h
    if (Number(p.viewMode) === 1) rect = [0, 0, led.w, led.h];
    else {
      const s = Math.min(ctx.width / led.w, ctx.height / led.h);
      const w = Math.round(led.w * s);
      const h = Math.round(led.h * s);
      rect = [Math.floor((ctx.width - w) / 2), Math.floor((ctx.height - h) / 2), w, h];
    }
    renderer.setViewport(rect[0], ctx.height - rect[1] - rect[3], rect[2], rect[3]);
    S.quadScreen.render(renderer);
    renderer.autoClear = true;
    renderer.setViewport(0, 0, ctx.width, ctx.height);

    const floor = persons.room?.found ? `Boden ${persons.room.height.toFixed(2)} m` : `kein Boden: Kinect ${p.camH} m`;
    ctx.status = `${persons.length} Person(en) · ${Math.round(people.count / 1000)}k Punkte · ${sparks.n} Partikel · ${floor} · Verzögerung ${Math.round(persons.delayMs || 0)} ms${S.lastEvent ? ` · ${S.lastEvent}` : ''}`;
  },

  dispose() {
    destroyAll();
  },
};

// ---------- helpers that use S ----------

function ensureTargets(p) {
  const w = Math.round(p.ledW);
  const h = Math.round(p.ledH);
  const ss = Number(p.ss) || 2;
  if (S.led && S.led.w === w && S.led.h === h && S.led.ss === ss) return S.led;
  S.led?.scene.dispose();
  S.led?.image.dispose();
  const scene = new THREE.RenderTarget(w * ss, h * ss, { type: THREE.HalfFloatType, depthBuffer: true });
  const image = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
  image.texture.minFilter = THREE.NearestFilter;
  image.texture.magFilter = THREE.NearestFilter;
  S.sceneTex.value = scene.texture;
  S.ledTex.value = image.texture;
  S.led = { w, h, ss, scene, image };
  return S.led;
}

/** short glitch bursts every few seconds: bands of the people jump, sometimes the whole image */
function updateGlitch(t, p, led) {
  const g = S.glitch;
  const U = S.people.U;
  // close to the wall the mirror cracks: more glitches, longer, more often over the whole image
  const near = S.near * p.near;
  const amount = Math.max(p.glitch, p.glitchImage) * (1 + 3 * near);
  if (amount > 0 && t >= g.next) {
    g.until = t + 0.07 + Math.random() * (0.2 + 0.2 * near);
    g.next = g.until + (2.5 + Math.random() * 7) / (0.3 + amount);
    g.image = Math.random() < 0.45 + 0.4 * near;
  }
  const active = amount > 0 && t < g.until;
  if (active && t >= g.change) {
    g.seed = Math.floor(Math.random() * 1000);
    g.change = t + 0.03 + Math.random() * 0.05;
  }
  U.glitch.value = active ? p.glitch : 0;
  U.glitchSeed.value = g.seed;
  S.post.slice.value = active && g.image ? p.glitchImage : 0;
  S.post.caGlitch.value = active ? (4 * p.glitchImage) / led.w : 0;
  S.post.seed.value = g.seed;
}

/** a glitch right now (events) */
function glitchNow(t, duration, image) {
  const g = S.glitch;
  g.until = Math.max(g.until, t + duration);
  g.change = 0;
  g.image = g.image || image;
  g.next = Math.max(g.next, g.until + 1.5);
}

/** how many of something with an expected count (fractions on average) */
function poisson(x) {
  const n = Math.floor(x);
  return n + (Math.random() < x - n ? 1 : 0);
}

const WHITE = new THREE.Color(1, 0.85, 0.92);

/** particles flying out of a point in all directions */
function burst(at, count, speed, ttl, ledPx, color, bright, gravity = 0) {
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const v = speed * (0.4 + Math.random() * 0.6);
    const b = bright * (0.6 + Math.random() * 0.8);
    S.sparks.spawn(
      at[0], at[1], at[2], r * Math.cos(a) * v, u * v * 0.8 + 0.2, r * Math.sin(a) * v,
      ttl * (0.6 + Math.random() * 0.6), ledPx * (1.3 + Math.random()), color.r * b, color.g * b, color.b * b, gravity, 0.3,
    );
  }
}

/** events (jumps, claps, eruptions, touches) and the poses held (charge, open, upload) */
function interaction(ctx, p, M, shift, ledPx, dt) {
  const t = ctx.time;
  const I = S.interact.update(ctx.persons, t, dt, p.front);
  const W = S.world.U;
  const c = new THREE.Color();
  const hot = new THREE.Color();
  S.kicks.length = 0;
  for (const e of I.events) {
    const at = worldToMirror(M, p.camX, shift, e.at, [0, 0, 0]);
    S.colorAt(at[2], c);
    hot.copy(c).lerp(WHITE, 0.5);
    if (e.type === 'jump' && p.quake > 0) {
      const s = e.strength * p.quake;
      W.quakes.array[S.quakeIndex++ % MAX_QUAKES].set(at[0], at[2], t, s);
      S.quakes.push({ t, s });
      S.shake = Math.min(1.2, Math.max(S.shake, 0.2 + 0.8 * s * s));
      S.slack = Math.max(S.slack, 0.4 + 0.6 * e.strength);
      if (s > 0.75) glitchNow(t, 0.1 + 0.15 * s, true);
      // dust from the floor around the feet
      for (let i = 0; i < 140 * s; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.15 + Math.random() * 0.4;
        const v = 0.6 + Math.random() * 1.4;
        const b = 0.8 + Math.random();
        S.sparks.spawn(
          at[0] + Math.cos(a) * r, 0.02, at[2] + Math.sin(a) * r, Math.cos(a) * v, 0.8 + Math.random() * 2.2 * s, Math.sin(a) * v,
          0.6 + Math.random() * 0.6, ledPx * (1.2 + Math.random()), hot.r * b, hot.g * b, hot.b * b, -6, 0.2,
        );
      }
      S.kicks.push({ p: [at[0], 0.3, at[2]], r: 2.2, s: 2.5 * s, up: 1 });
    } else if (e.type === 'clap' && p.clap > 0) {
      const s = (0.5 + 0.5 * e.strength) * p.clap;
      burst(at, Math.round(170 * s), 3.2, 0.5, ledPx, hot, 2.2);
      S.flash = Math.max(S.flash, 0.45 * s);
      glitchNow(t, 0.1, true);
      S.kicks.push({ p: at, r: 1.6, s: 4 * s, up: 0 });
    } else if (e.type === 'erupt' && p.charge > 0) {
      burst(at, Math.round(220 * p.charge), 2.5, 0.7, ledPx, WHITE, 2.5);
      S.flash = Math.max(S.flash, 0.7 * p.charge);
      S.shake = Math.max(S.shake, 0.5);
      glitchNow(t, 0.25, true);
      S.kicks.push({ p: at, r: 2, s: 3, up: 1.5 });
    } else if (e.type === 'touch' && p.arcs > 0) {
      burst(at, Math.round(200 * p.arcs), 2.4, 0.6, ledPx, WHITE, 2.4);
      S.flash = Math.max(S.flash, 0.5 * p.arcs);
      glitchNow(t, 0.18, true);
    } else continue;
    S.lastEvent = { jump: 'Sprung: Beben', clap: 'Klatschen', erupt: 'Arme hoch: Ausbruch', touch: 'Berührung' }[e.type];
    S.lastEventAt = t;
  }
  if (S.lastEvent && t - S.lastEventAt > 2) S.lastEvent = '';

  // held poses
  let charge = 0;
  let open = 0;
  let upload = 0;
  const dissolve = S.people.U.dissolve.array;
  for (let s = 0; s < 17; s++) dissolve[s] = 0;
  for (const q of I.people) {
    const person = q.person;
    open = Math.max(open, q.open);
    charge = Math.max(charge, q.charge);
    upload = Math.max(upload, q.upload);
    if (q.slot >= 1 && q.slot <= 16) dissolve[q.slot] = q.upload * p.upload * 0.92;
    // energy gathers in the raised hands; when full, a pillar of light shoots up
    if (q.up && q.charge > 0.02 && p.charge > 0) {
      for (const h of HANDS) {
        const j = person.joints[h];
        if (!j) continue;
        const m = worldToMirror(M, p.camX, shift, j, [0, 0, 0]);
        // particles spiral in from all around (more and brighter the fuller it gets) and a glow in the hand
        const n = poisson((120 + q.charge * 380) * p.charge * dt);
        for (let i = 0; i < n; i++) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const r = 0.5 + Math.random() * 0.9;
          const d = [Math.sqrt(1 - u * u) * Math.cos(a) * r, u * r, Math.sqrt(1 - u * u) * Math.sin(a) * r];
          const T = 0.35 + Math.random() * 0.25;
          // a tangential part makes them swirl
          const sw = 0.8;
          const b = 1.4 + q.charge * 2;
          S.sparks.spawn(m[0] + d[0], m[1] + d[1], m[2] + d[2], -d[0] / T - d[2] * sw, -d[1] / T, -d[2] / T + d[0] * sw, T, ledPx * (1.5 + q.charge), WHITE.r * b, WHITE.g * b * 0.7, WHITE.b * b * 0.85, 0, 0);
        }
        S.sparks.point(m[0], m[1], m[2] + 0.03, ledPx * (2 + 5 * q.charge), 2 + 4 * q.charge, (1 + 2 * q.charge) * 0.6, (1 + 2 * q.charge) * 0.8);
        if (q.charge >= 1) {
          const k = poisson(700 * p.charge * dt);
          for (let i = 0; i < k; i++) {
            const b = 2.5 + Math.random() * 2;
            const sp = 0.06 + Math.random() * 0.1;
            const a = Math.random() * Math.PI * 2;
            S.sparks.spawn(
              m[0] + Math.cos(a) * sp, m[1], m[2] + Math.sin(a) * sp, Math.cos(a) * 0.2, 4 + Math.random() * 6, Math.sin(a) * 0.2,
              0.5 + Math.random() * 0.6, ledPx * (1.8 + Math.random() * 1.5), b, b * 0.55, b * 0.7, 0, 0,
            );
          }
        }
      }
    }
    // standing still: the body flows away into the core
    if (q.upload > 0.02 && p.upload > 0 && S.people.count) {
      const n = poisson(q.upload * 700 * p.upload * dt);
      const pos = S.people.pos;
      const info = S.people.info;
      for (let i = 0; i < n; i++) {
        let k = -1;
        for (let tries = 0; tries < 8 && k < 0; tries++) {
          const r = Math.floor(Math.random() * S.people.count);
          if (Math.floor(info[4 * r + 2]) === q.slot) k = r;
        }
        if (k < 0) break;
        const x = pos[3 * k];
        const y = pos[3 * k + 1];
        const z = pos[3 * k + 2];
        // first up and a little apart, then off into the core: a stream of the body's dots
        const T = 2.2 + Math.random() * 1.2;
        const tx = CORE[0] + (Math.random() - 0.5) * 4;
        const ty = CORE[1] + (Math.random() - 0.5) * 10;
        S.colorAt(z, c);
        c.lerp(WHITE, 0.3);
        const b = 1.6 + Math.random() * 1.4;
        S.sparks.spawn(x, y, z, (tx - x) / T + (Math.random() - 0.5) * 0.4, (ty - y) / T + 0.4, (CORE[2] - z) / T, T * 0.95, ledPx * 1.6, c.r * b, c.g * b, c.b * b, 0, 0.8);
      }
    }
  }
  W.open.value = Math.min(1, open) * p.open;
  W.boost.value = Math.min(1.5, charge * p.charge + upload * 0.5 * p.upload);
  // the wall trembles after a quake
  S.quakes = S.quakes.filter((q) => t - q.t < 3);
  W.quake.value = S.quakes.reduce((a, q) => a + q.s * Math.exp(-(t - q.t) * 2.2), 0);
  S.shake *= Math.exp(-dt * 3.5);
  S.slack *= Math.exp(-dt * 4);
  S.flash *= Math.exp(-dt * 6);
  S.near += (I.near - S.near) * Math.min(1, dt * 2);
  S.arcs = I.arcs;
}

/** crackling arcs between the hands of two people */
function arcs(p, M, shift, ledPx) {
  if (!S.arcs.length || p.arcs <= 0) return;
  for (const arc of S.arcs) {
    const a = worldToMirror(M, p.camX, shift, arc.a, [0, 0, 0]);
    const b = worldToMirror(M, p.camX, shift, arc.b, [0, 0, 0]);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const N = 40;
    const amp = 0.05 + 0.12 * Math.sqrt(L) * (1 - 0.5 * arc.strength);
    const s = arc.strength * p.arcs;
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const env = Math.sin(Math.PI * f);
      ox = ox * 0.6 + (Math.random() - 0.5) * amp;
      oy = oy * 0.6 + (Math.random() - 0.5) * amp;
      oz = oz * 0.6 + (Math.random() - 0.5) * amp * 0.5;
      const br = (0.8 + 1.8 * s) * (0.6 + 0.4 * Math.random());
      S.sparks.point(a[0] + (b[0] - a[0]) * f + ox * env, a[1] + (b[1] - a[1]) * f + oy * env, a[2] + (b[2] - a[2]) * f + oz * env, ledPx * 1.4, br * 0.85, br * 0.7, br);
    }
    if (Math.random() < s) burst(Math.random() < 0.5 ? a : b, 2, 1, 0.3, ledPx, WHITE, 1.5);
  }
}

/** strings from head and hands up to the puppeteer */
function marionette(ctx, p, M, shift, ledPx, wallTop, dt) {
  const c = S.stringColor.set(p.stringColor);
  const joint = (q, name) => {
    const j = name === 'head' ? q.head : q.joints[name];
    return j ? worldToMirror(M, p.camX, shift, j, [0, 0, 0]) : null;
  };
  const motion = (q, name) => (q.motion[name] ? dirToMirror(M, q.motion[name], [0, 0, 0]) : null);
  S.strings.update(
    ctx.persons, ctx.time, dt, joint, motion,
    { eyeH: p.eyeH, eyeDist: p.eyeDist, wallTop, ledPx },
    { amount: p.strings, target: p.stringTarget, color: [c.r, c.g, c.b], swing: p.swing, slack: S.slack, dissolve: (slot) => S.people.U.dissolve.array[slot] },
    (x, y, z, size, r, g, b) => S.sparks.point(x, y, z, size, r, g, b),
  );
}

/** the swarm in the air follows hands and feet */
function swarmStep(ctx, p, M, shift, dt) {
  const movers = [];
  if (p.swarm > 0) {
    for (const q of ctx.persons) {
      for (const name of MOVERS) {
        const j = q.joints[name];
        const v = q.motion[name];
        if (!j || !v) continue;
        movers.push({ p: worldToMirror(M, p.camX, shift, j, [0, 0, 0]), v: dirToMirror(M, v, [0, 0, 0]) });
      }
    }
  }
  S.swarm.update(Math.min(dt, 0.05), ctx.time, movers, S.kicks, p.swarm);
}

/** particles blown off the contour of everyone */
function shedDust(p, since, ledPx) {
  const { people, sparks } = S;
  const nc = people.contourCount;
  if (!nc || p.dust <= 0) return;
  const persons = Math.max(1, S.idSlot.size);
  const count = Math.min(260, Math.round(p.dust * 320 * persons * since));
  const pos = people.pos;
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const n = people.contour[Math.floor(Math.random() * nc)];
    c.copy(S.nearColor).lerp(S.farColor, people.info[4 * n + 3]);
    const b = 0.6 + Math.random() * 0.8;
    sparks.spawn(
      pos[3 * n], pos[3 * n + 1], pos[3 * n + 2],
      p.wind * (0.2 + Math.random() * 0.5), 0.03 + Math.random() * 0.12, -0.05 - Math.random() * 0.2,
      1 + Math.random() * 1.6, ledPx * (1 + Math.random()) * 1.2, c.r * b, c.g * b, c.b * b, 0, 0.6,
    );
  }
}

/** light trails behind fast hands */
function handTrails(ctx, p, M, shift, since, ledPx) {
  const { sparks, hands } = S;
  const seen = new Set();
  const c = new THREE.Color();
  for (const q of ctx.persons) {
    S.idSlot.set(q.id, q.slot);
    for (const h of HANDS) {
      const j = q.joints[h];
      const key = `${q.id}:${h}`;
      if (!j) continue;
      seen.add(key);
      const cur = worldToMirror(M, p.camX, shift, j, [0, 0, 0]);
      const last = hands.get(key);
      hands.set(key, cur);
      const m = q.motion[h];
      const speed = m ? Math.hypot(m[0], m[1], m[2]) : 0;
      if (!last || p.trails <= 0 || speed < 0.6 || (q.confidence[h] ?? 1) < 0.3) continue;
      const count = Math.min(40, Math.round((speed - 0.4) * since * 160 * p.trails));
      S.colorAt(cur[2], c);
      for (let i = 0; i < count; i++) {
        const f = Math.random();
        const b = 1 + Math.random() * 1.2;
        sparks.spawn(
          last[0] + (cur[0] - last[0]) * f + (Math.random() - 0.5) * 0.03,
          last[1] + (cur[1] - last[1]) * f + (Math.random() - 0.5) * 0.03,
          last[2] + (cur[2] - last[2]) * f + (Math.random() - 0.5) * 0.03,
          p.wind * 0.15 + (Math.random() - 0.5) * 0.06, 0.02 + Math.random() * 0.05, -0.02 - Math.random() * 0.05,
          0.6 + Math.random() * 0.9, ledPx * (1.2 + Math.random()) * 1.3, (c.r * 0.8 + 0.2) * b, (c.g * 0.8 + 0.2) * b, (c.b * 0.8 + 0.2) * b, 0, 0.35,
        );
      }
    }
  }
  for (const key of hands.keys()) if (!seen.has(key)) hands.delete(key);
}

/** whoever leaves falls apart into particles */
function leaving(ctx, p, ledPx) {
  const { sparks, people } = S;
  const c = new THREE.Color();
  for (const id of ctx.persons.left ?? []) {
    const slot = S.idSlot.get(id);
    S.idSlot.delete(id);
    if (!slot || p.burst <= 0) continue;
    const r = people.reservoir[slot];
    for (let i = 0; i < r.n; i++) {
      if (Math.random() > p.burst) continue;
      S.colorAt(r.xyz[3 * i + 2], c);
      const b = 1 + Math.random() * 1.5;
      sparks.spawn(
        r.xyz[3 * i], r.xyz[3 * i + 1], r.xyz[3 * i + 2],
        p.wind * 0.6 + (Math.random() - 0.5) * 0.5, 0.1 + Math.random() * 0.4, (Math.random() - 0.7) * 0.4,
        0.8 + Math.random() * 1.2, ledPx * (1.2 + Math.random()) * 1.3, c.r * b, c.g * b, c.b * b, -0.15, 1.4,
      );
    }
  }
}

/** glowing eyes: two small lights in the face of everyone looking at the wall */
function eyes(ctx, p, M, shift, ledPx) {
  if (p.eyes <= 0) return;
  for (const q of ctx.persons) {
    if ((q.confidence.nose ?? 0) < 0.4) continue;
    for (const e of FACE) {
      const j = q.joints[e];
      if (!j || (q.confidence[e] ?? 0) < 0.45) continue;
      const m = worldToMirror(M, p.camX, shift, j, S.tmp);
      const b = 4 * p.eyes;
      S.sparks.point(m[0], m[1], m[2] + 0.04, ledPx * 2.4, b, 0.25 * b, 0.35 * b);
    }
  }
}

/** ripples on the floor around everyone's feet, fading in and out */
function updateMarks(ctx, p, M, shift, dt) {
  const marks = S.marks;
  const now = ctx.time;
  for (const q of ctx.persons) {
    if (!q.ground) continue;
    const g = worldToMirror(M, p.camX, shift, q.ground, S.tmp);
    let m = marks.get(q.id);
    if (!m) marks.set(q.id, (m = { x: g[0], z: g[2], alpha: 0, seen: now }));
    m.x += (g[0] - m.x) * Math.min(1, dt * 8);
    m.z += (g[2] - m.z) * Math.min(1, dt * 8);
    m.seen = now;
  }
  const U = S.world.U;
  let i = 0;
  for (const [id, m] of marks) {
    const alive = now - m.seen < 0.1;
    m.alpha = Math.max(0, Math.min(1, m.alpha + (alive ? dt / 0.5 : -dt / 0.8)));
    if (!alive && m.alpha <= 0) {
      marks.delete(id);
      continue;
    }
    if (i < MAX_MARKS) {
      U.marks.array[i].set(m.x, m.z, m.alpha, 0);
      S.colorAt(m.z, U.markColors.array[i]).multiplyScalar(p.ripples);
      i++;
    }
  }
  for (; i < MAX_MARKS; i++) U.marks.array[i].set(0, -100, 0, 0);
}

function destroyAll() {
  if (!S) return;
  S.led?.scene.dispose();
  S.led?.image.dispose();
  S.world.dispose();
  S.people.dispose();
  S.sparks.dispose();
  S.swarm.dispose();
  S.mats.forEach((m) => m.dispose());
  S.bloomNode.dispose?.();
  S.renderer.dispose();
  S = null;
}
