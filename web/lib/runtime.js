// runtime.js — runs one scene (scenes/<name>/main.js): canvas, render loop, Kinect data, parameter
// panel, HUD, error display and hot swap. Saving the scene replaces it in place; the hub connection,
// the GPU device, the camera and the parameter values stay. Scene API: ../AGENTS.md
//
// Keys of the runtime: h UI on/off · f fullscreen · m mirror · , . previous/next scene (all worktrees)
// Person tracking: streams: ['persons'] plus optional persons: {...} (or (params) => {...}), see
// ../PERSONS.md; ctx.persons is the list of Person objects.
// LED wall (../WALL.md): ctx.wall is the wall setup, the scene's projection and the mapping Kinect ->
// wall (one WallMap per scene instance: two scenes in a crossfade map with their own projection). A scene with
// `wall: true` renders the LED image (canvas = LED pixels, shown scaled to fit). /wall/ is the output
// window for the LED controller: it plays the show of the control center (/control/, lib/wall-output.js)
// and switches scenes in place with a crossfade.
// URL options: ?hub=8091 (other hub) · ?kiosk (no UI at all) · ?fps=30 (cap the render rate)
//              · ?nothumb (no thumbnail upload)

import { KinectData, KinectGpu } from './kinect-data.js';
import { PERSON_OPTIONS } from './persons.js';
import { ParamPanel } from './params.js';
import { OrbitCamera } from './camera.js';
import { WallMap, normalizeProjectionDoc, resolveProjection } from './wall.js';
import { WallBus, loadDoc } from './wall-bus.js';
import { hubUrl, wsUrl, devServer, localScenes, allDevServers } from './hub.js';
import loaders from 'virtual:kinect-scene-loaders';
import './runtime.css';

const query = new URLSearchParams(location.search);
/** /wall/: the output window for the LED controller (no UI, plays the show) */
const OUTPUT = /^\/wall\/?$/.test(location.pathname);
/** /wall/?embed: the same as a live preview inside the control center (fits its frame) */
const EMBED = OUTPUT && query.has('embed');
/** the control center page that embeds this preview (its wall bus id) */
const OWNER = EMBED ? (query.get('owner') ?? '') : '';
const URL_NAME = decodeURIComponent(/\/scenes\/([^/]+)\/?/.exec(location.pathname)?.[1] ?? query.get('scene') ?? '');
const HUB = hubUrl();
const KIOSK = OUTPUT || query.has('kiosk');
const THUMBS = !OUTPUT && !!devServer() && !query.has('nothumb');
const FPS_CAP = Number(query.get('fps')) || 0;

function el(tag, className, parent, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

function remember(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: not remembered
  }
}

// ---------- state ----------

const stage = document.getElementById('stage') ?? document.body;
const hud = el('div', 'k-hud', document.body);
const banner = el('div', 'k-banner', document.body);
const errorBox = el('div', 'k-error', document.body);
if (KIOSK) document.documentElement.classList.add('k-kiosk');
if (OUTPUT) document.documentElement.classList.add('k-output');

const rt = {
  title: URL_NAME,
  info: null,
  state: 'loading', // loading | running | error
  current: null, // the running scene instance
  pending: null, // an instance whose setup() is still running
  leaving: [], // instances fading out (crossfade), still rendering
  errors: [],
  frames: 0,
  swaps: 0,
  fps: 0,
  fpsCount: 0,
  fpsSince: performance.now(),
  scenes: [], // this dev server's scenes (all of them)
  setupSource: 'none',
};

const kinect = new KinectData(wsUrl(HUB));
kinect.connect();
const camera = new OrbitCamera();
const panel = new ParamPanel();
/** the wall of the page (setup, block zones, the default projection); each scene has its own (inst.wall) */
const wall = new WallMap();
wall.output = OUTPUT && !EMBED;
let projectionRaw = null; // projection.json as loaded (null: the default comes from the setup)
let projections = normalizeProjectionDoc(null, wall.setup);
// block zones of the wall setup: nobody standing in one is tracked, for every scene
kinect.personFilter = (result, opts) => wall.filterPersons(result, opts);
const bus = new WallBus(OUTPUT ? 'output' : 'scene');
let xSign = remember('kinect:xSign', -1) === 1 ? 1 : -1;
let uiHidden = KIOSK || remember('kinect:uiHidden', false) === true;
/** set by lib/wall-output.js: called after every rendered frame */
const hooks = { afterFrame: null, beforeFrame: null };

// ---------- errors ----------

function cleanStack(stack) {
  return String(stack ?? '')
    .split('\n')
    .filter((l) => /\/(scenes|lib)\//.test(l))
    .slice(0, 6)
    .map((l) => l.trim().replace(/https?:\/\/[^/]+\//, '').replace(/\?[^:)]*/, ''))
    .join('\n');
}

function pushError(where, err) {
  const message = String(err?.message ?? err ?? 'unbekannter Fehler');
  const known = rt.errors.find((e) => e.where === where && e.message === message);
  if (known) {
    known.count++;
    known.at = Date.now();
  } else {
    rt.errors.push({ where, message, stack: cleanStack(err?.stack), count: 1, at: Date.now(), scene: rt.current?.name ?? rt.pending?.name ?? URL_NAME });
    if (rt.errors.length > 20) rt.errors.shift();
    console.error(`[${rt.current?.name ?? URL_NAME}] ${where}:`, err);
  }
  renderErrors();
}

function clearErrors() {
  rt.errors = [];
  renderErrors();
}

function renderErrors() {
  errorBox.replaceChildren();
  errorBox.style.display = rt.errors.length && !KIOSK ? 'block' : 'none';
  if (!rt.errors.length || KIOSK) return;
  const head = el('div', 'k-error-head', errorBox);
  el('b', '', head, rt.state === 'error' ? 'Szene angehalten' : 'Fehler');
  const actions = el('span', 'k-error-actions', head);
  if (rt.state === 'error' && rt.current) {
    el('button', '', actions, 'Weiter versuchen').onclick = () => {
      rt.state = 'running';
      clearErrors();
    };
  }
  el('button', '', actions, 'Schließen').onclick = clearErrors;
  for (const e of rt.errors.slice(-5)) {
    el('div', 'k-error-msg', errorBox, `${e.where}${e.count > 1 ? ` (${e.count}×)` : ''}: ${e.message}`);
    if (e.stack) el('div', 'k-error-stack', errorBox, e.stack);
  }
  el('div', 'k-error-hint', errorBox, 'Datei speichern = neuer Versuch (Hot-Swap)');
}

addEventListener('error', (e) => pushError('Fehler', e.error ?? e.message));
addEventListener('unhandledrejection', (e) => pushError('Promise', e.reason));
if (import.meta.hot) {
  import.meta.hot.on('vite:error', (p) => pushError('Vite', p?.err ?? p));
  import.meta.hot.on('kinect:scenes', () => refreshInfo());
  // a hot update that fails (e.g. the new code throws at import) is only logged by Vite
  const consoleError = console.error.bind(console);
  console.error = (...args) => {
    consoleError(...args);
    if (typeof args[0] === 'string' && args[0].startsWith('[hmr] Failed')) pushError('Hot-Swap', args[0].replace('[hmr] ', ''));
  };
}

// ---------- the LED wall setup (shared by every page, see WALL.md) ----------

/** every scene instance alive on this page (each with its own WallMap) */
const liveInstances = () => [rt.pending, rt.current, ...rt.leaving.map((l) => l.inst)].filter(Boolean);

/** The projection of a scene instance: the default, the scene's own wishes, the control center's values. */
const projectionOf = (inst) => resolveProjection(projections, inst.name, inst.def.projection, { setup: wall.setup, tanH: wall.tanH });

/** Setup or projections changed: every wall map takes them. */
function applyWall() {
  projections = normalizeProjectionDoc(projectionRaw, wall.setup);
  wall.setProjection(projections.default);
  for (const inst of liveInstances()) {
    inst.wall.setSetup(wall.setup);
    try {
      inst.wall.setProjection(projectionOf(inst));
    } catch (e) {
      pushError('Projektion', e);
    }
  }
  // the output's camera view mirrors like the default projection (wall scenes map with their own)
  if (OUTPUT) xSign = projections.default.mirror ? 1 : -1;
}

async function loadSetup() {
  const { doc, source } = await loadDoc('setup');
  wall.setSetup(doc ?? {});
  rt.setupSource = source;
  applyWall();
}
async function loadProjections() {
  const { doc } = await loadDoc('projection');
  projectionRaw = doc;
  applyWall();
}
// the control center sends every change at once; the file follows a moment later (an older save
// must not undo a newer live change)
const liveAt = { setup: -1e9, projection: -1e9 };
bus.on('setup', (d) => {
  if (!d?.setup) return;
  liveAt.setup = performance.now();
  wall.setSetup(d.setup);
  applyWall();
});
bus.on('projection', (d) => {
  if (!d?.projection) return;
  liveAt.projection = performance.now();
  projectionRaw = d.projection;
  applyWall();
});
bus.on('file', (d) => {
  if (d.kind === 'setup' && performance.now() - liveAt.setup > 3000) loadSetup();
  if (d.kind === 'projection' && performance.now() - liveAt.projection > 3000) loadProjections();
});

// ---------- WebGPU: one device per page, shared by every scene instance ----------

let devicePromise = null;
function gpuDevice() {
  devicePromise ??= (async () => {
    if (!navigator.gpu) throw new Error('Dieser Browser hat kein WebGPU. Bitte aktuelles Chrome oder Edge verwenden.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('Kein WebGPU-Adapter verfügbar (Grafiktreiber?)');
    const requiredFeatures = ['float32-filterable', 'timestamp-query'].filter((f) => adapter.features.has(f));
    const device = await adapter.requestDevice({ requiredFeatures });
    device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      pushError('WebGPU', `GPU-Gerät verloren (${info.message}) – lade neu`);
      setTimeout(() => location.reload(), 1500);
    });
    device.addEventListener('uncapturederror', (e) => pushError('WebGPU', e.error));
    kinect.gpu = new KinectGpu(device);
    return { adapter, device };
  })();
  return devicePromise;
}

// ---------- scene instances ----------

function sceneDefinition(mod) {
  const def = mod?.default ?? mod;
  if (!def || typeof def !== 'object' || (typeof def.frame !== 'function' && typeof def.setup !== 'function')) {
    throw new Error('main.js muss eine Szene exportieren: export default { setup(ctx) {…}, frame(ctx) {…} }');
  }
  return def;
}

/** Does this instance render the LED image (canvas = LED pixels)? */
const isWall = (inst) => OUTPUT || !!inst?.def.wall;

function createContext(inst) {
  const ctx = {
    scene: inst.name,
    canvas: inst.canvas,
    dom: inst.dom,
    width: 1,
    height: 1,
    pixelRatio: 1,
    time: 0,
    dt: 0,
    frame: 0,
    params: inst.params.values,
    paramSpecs: inst.params.list,
    kinect,
    pointer: { x: 0, y: 0, down: false },
    status: '',
    get xSign() {
      return xSign;
    },
    /** The tracked persons (streams: ['persons']): Person objects, see PERSONS.md. */
    get persons() {
      return kinect.view;
    },
    /** The LED wall: setup, this scene's projection and the mapping Kinect -> wall, see WALL.md. */
    get wall() {
      return inst.wall;
    },
    /** Depth image pixel (u, v) -> canvas pixels, as kinectUv() in 2D shaders (CSS px: / pixelRatio). */
    kinectToScreen(u, v) {
      if (inst.wall.active) {
        const w = inst.wall.imageToWall(u, v, kinect.lut?.data);
        if (!w) return [-1e4, -1e4];
        const [px, py] = inst.wall.uv(w);
        return [px * ctx.width, py * ctx.height];
      }
      let kx = (u + 0.5) / 512;
      let ky = (v + 0.5) / 424;
      if (xSign < 0) kx = 1 - kx;
      const screen = ctx.width / Math.max(1, ctx.height);
      const image = 512 / 424;
      kx -= 0.5;
      ky -= 0.5;
      if (screen > image) ky = (ky * screen) / image;
      else kx = (kx * image) / screen;
      return [(kx + 0.5) * ctx.width, (ky + 0.5) * ctx.height];
    },
    /** World point (m, the space of ctx.camera) -> canvas pixels; null if behind the camera. */
    worldToScreen(p) {
      const m = ctx.camera.viewProj;
      const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
      const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (w <= 1e-6) return null;
      return [((x / w) * 0.5 + 0.5) * ctx.width, (0.5 - (y / w) * 0.5) * ctx.height];
    },
    get camera() {
      if (!inst.cameraAttached) {
        inst.cameraAttached = true;
        camera.attach(inst.canvas, ctx.on);
        camera.update(performance.now(), ctx.width, ctx.height);
      }
      return camera;
    },
    async webgpu({ alphaMode = 'opaque' } = {}) {
      if (inst.gpu) return inst.gpu;
      const { adapter, device } = await gpuDevice();
      const context = inst.canvas.getContext('webgpu');
      if (!context) throw new Error('Canvas hat schon einen anderen Kontext (2d/webgl)');
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode });
      inst.gpu = { adapter, device, context, format };
      return inst.gpu;
    },
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      inst.disposers.push(() => target.removeEventListener(type, fn, opts));
    },
    onDispose(fn) {
      inst.disposers.push(fn);
    },
    track(resource) {
      inst.disposers.push(() => resource?.destroy?.());
      return resource;
    },
    setStreams(list) {
      inst.streamsOverride = list;
      updateStreams();
    },
  };
  return ctx;
}

function wantedStreams(inst) {
  let s = inst.streamsOverride ?? inst.def.streams ?? ['depth'];
  if (typeof s === 'function') {
    try {
      s = s(inst.params.values);
    } catch (e) {
      pushError('streams()', e);
      s = ['depth'];
    }
  }
  return Array.isArray(s) ? s : ['depth'];
}

/** The scene's `persons` options (object or (params) => object) over the defaults. */
function wantedPersons(inst) {
  let o = inst.def.persons ?? {};
  if (typeof o === 'function') {
    try {
      o = o(inst.params.values);
    } catch (e) {
      pushError('persons()', e);
      o = {};
    }
  }
  return { ...PERSON_OPTIONS, ...(o && typeof o === 'object' ? o : {}) };
}

let personConfig = '';
/** Subscribes what every live instance needs (during a crossfade both scenes render). */
function updateStreams() {
  const live = [rt.pending ?? rt.current, ...rt.leaving.map((l) => l.inst)].filter(Boolean);
  if (!live.length) return;
  // a page nobody sees gets no Kinect data: the hub then stops tracking and posing for it
  const streams = pageHidden ? [] : [...new Set(live.flatMap(wantedStreams))];
  kinect.setStreams(streams);
  if (!streams.includes('persons')) return;
  // the newest scene that tracks persons decides how
  const owner = live.find((i) => wantedStreams(i).includes('persons'));
  const key = JSON.stringify(wantedPersons(owner));
  if (key === personConfig) return;
  personConfig = key;
  kinect.personTracker.configure(JSON.parse(key));
}

/** Canvas size (device px) and its place on the page (CSS px; null = the whole window). */
function layout(inst) {
  if (isWall(inst)) {
    const led = wall.setup.led;
    const out = wall.setup.output;
    const dpr = devicePixelRatio || 1;
    let css;
    if (OUTPUT && !EMBED && out.fit === 'pixel') css = [out.x / dpr, out.y / dpr, led.w / dpr, led.h / dpr];
    else if (OUTPUT && !EMBED && out.fit === 'stretch') css = [0, 0, innerWidth, innerHeight];
    else {
      const pad = OUTPUT ? 0 : 16;
      const s = Math.min(Math.max(1, innerWidth - 2 * pad) / led.w, Math.max(1, innerHeight - 2 * pad) / led.h);
      const w = led.w * s;
      const h = led.h * s;
      css = [(innerWidth - w) / 2, (innerHeight - h) / 2, w, h];
    }
    return { w: led.w, h: led.h, css };
  }
  const ratio = inst.def.pixelRatio ?? Math.min(devicePixelRatio || 1, 2);
  let w = Math.max(1, Math.round(innerWidth * ratio));
  let h = Math.max(1, Math.round(innerHeight * ratio));
  const maxWidth = inst.def.maxWidth ?? 3840;
  if (w > maxWidth) {
    h = Math.max(1, Math.round((h * maxWidth) / w));
    w = maxWidth;
  }
  return { w, h, css: null };
}

function sizeCanvas(inst) {
  const { w, h, css } = layout(inst);
  const key = css ? css.map((v) => v.toFixed(2)).join(',') : 'full';
  if (key !== inst.cssKey) {
    inst.cssKey = key;
    for (const e of [inst.canvas, inst.dom]) {
      e.classList.toggle('k-led', !!css);
      e.style.left = css ? `${css[0]}px` : '';
      e.style.top = css ? `${css[1]}px` : '';
      e.style.width = css ? `${css[2]}px` : '';
      e.style.height = css ? `${css[3]}px` : '';
    }
    inst.canvas.classList.toggle('k-led-preview', !!css && !OUTPUT);
    // LED pixels stay square blocks when the preview shows them larger than 1:1
    inst.canvas.style.imageRendering = css && css[2] / w >= 1.5 ? 'pixelated' : '';
  }
  const ctx = inst.ctx;
  ctx.pixelRatio = w / Math.max(1, css ? css[2] : innerWidth);
  if (w === ctx.width && h === ctx.height) return;
  inst.canvas.width = w;
  inst.canvas.height = h;
  ctx.width = w;
  ctx.height = h;
  if (inst.ready) {
    try {
      inst.def.resize?.(ctx);
    } catch (e) {
      pushError('resize()', e);
    }
  }
}

function destroy(inst) {
  try {
    inst.def.dispose?.(inst.ctx);
  } catch (e) {
    pushError('dispose()', e);
  }
  for (const d of inst.disposers.splice(0).reverse()) {
    try {
      d();
    } catch (e) {
      console.warn('cleanup', e);
    }
  }
  try {
    inst.gpu?.context.unconfigure();
  } catch {
    // canvas is going away anyway
  }
  inst.canvas.remove();
  inst.dom.remove();
}

/**
 * Starts a scene module. name: the scene; swap: a hot swap of the running scene; overrides: param
 * values instead of the stored ones (output: the show entry); transition 'cross' | 'cut' and fade (s).
 */
async function launch(mod, { name = URL_NAME, swap = false, overrides = null, transition = 'cut', fade = 1 } = {}) {
  let def;
  try {
    def = sceneDefinition(mod);
  } catch (e) {
    pushError(swap ? 'Hot-Swap' : 'Laden', e);
    if (!rt.current) rt.state = 'error';
    return false;
  }
  const canvas = el('canvas', 'k-canvas k-pending');
  const dom = el('div', 'k-scene-dom');
  stage.append(canvas, dom);
  const inst = { name, def, canvas, dom, disposers: [], overrides, params: panel.resolve(name, def.params, overrides), started: performance.now(), frame: 0, ready: false };
  // the scene's own wall map: its projection (default, the scene's wishes, the control center's values)
  inst.wall = new WallMap(wall.setup, wall.projection);
  inst.wall.output = wall.output;
  try {
    inst.wall.setProjection(projectionOf(inst));
  } catch (e) {
    pushError('Projektion', e);
  }
  inst.disposers.push(() => inst.wall.destroy());
  inst.ctx = createContext(inst);
  syncWall(inst, performance.now());
  const ctx = inst.ctx;
  ctx.on(canvas, 'pointermove', (e) => {
    const r = canvas.width / Math.max(1, canvas.clientWidth);
    ctx.pointer.x = e.offsetX * r;
    ctx.pointer.y = e.offsetY * r;
  });
  ctx.on(canvas, 'pointerdown', () => (ctx.pointer.down = true));
  ctx.on(window, 'pointerup', () => (ctx.pointer.down = false));
  sizeCanvas(inst);
  if (!swap) {
    // a scene runs only once at a time: its instances share the module's variables (`let pass`), so
    // setup() of a new one would hand the old one its resources and the old one's dispose() would
    // free them. One still fading out or stopped by an error goes first. (A hot swap is a new module.)
    for (const l of rt.leaving.filter((l) => l.inst.name === name)) {
      rt.leaving.splice(rt.leaving.indexOf(l), 1);
      destroy(l.inst);
    }
    if (rt.current?.name === name) {
      destroy(rt.current);
      rt.current = null;
    }
  }
  rt.pending = inst;
  updateStreams();
  try {
    await def.setup?.(ctx);
  } catch (e) {
    rt.pending = null;
    destroy(inst);
    pushError(swap && rt.current ? 'setup() – die vorige Version läuft weiter' : 'setup()', e);
    if (rt.current) updateStreams();
    else rt.state = 'error';
    renderErrors();
    return false;
  }
  if (rt.pending !== inst) {
    destroy(inst); // a newer version arrived while this one was still setting up
    return false;
  }
  rt.pending = null;
  inst.ready = true;
  const old = rt.current;
  rt.current = inst;
  canvas.classList.remove('k-pending');
  if (!KIOSK) {
    panel.mount(inst.params, (key, value) => {
      try {
        def.onParam?.(key, value, ctx);
      } catch (e) {
        pushError('onParam()', e);
      }
      updateStreams();
    });
  }
  if (old) {
    if (transition === 'cross' && fade > 0 && !swap) {
      // the new canvas lies on top and fades in; the old one keeps rendering below until then
      canvas.style.opacity = '0';
      canvas.getBoundingClientRect();
      canvas.style.transition = `opacity ${fade}s ease-in-out`;
      requestAnimationFrame(() => (canvas.style.opacity = '1'));
      rt.leaving.push({ inst: old, until: performance.now() + fade * 1000 + 100 });
    } else destroy(old);
  }
  rt.state = 'running';
  if (swap) rt.swaps++;
  if (!OUTPUT) clearErrors();
  scheduleThumb();
  updateStreams();
  return true;
}

// ---------- new param values for a running instance (output window: show entries) ----------

const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const hex = (v) => `#${v.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;

/** Sets one param as the panel would (onParam); true if it changed. */
function setValue(inst, key, value) {
  if (inst.params.values[key] === value) return false;
  inst.params.values[key] = value;
  try {
    inst.def.onParam?.(key, value, inst.ctx);
  } catch (e) {
    pushError('onParam()', e);
  }
  return true;
}

/**
 * The values of `overrides` (as in launch(): missing ones get the defaults) for a running instance.
 * With `fade` (s) numbers and colors glide there (stepGlide()), everything else switches at once.
 */
function retune(inst, overrides, fade = 0) {
  inst.overrides = overrides;
  const { list, values } = panel.resolve(inst.name, inst.def.params, overrides);
  const glide = { from: {}, to: {}, start: performance.now(), ms: fade * 1000 };
  for (const p of list) {
    const now = inst.params.values[p.key];
    const want = values[p.key];
    if (now === want) continue;
    if (fade > 0 && (p.kind === 'number' || p.kind === 'color') && typeof now === typeof want) {
      glide.from[p.key] = now;
      glide.to[p.key] = want;
    } else setValue(inst, p.key, want);
  }
  inst.glide = Object.keys(glide.to).length ? glide : null;
  updateStreams();
}

/** One step of a running glide (render loop). Integer params stay integers. */
function stepGlide(inst, now) {
  const g = inst.glide;
  const t = Math.min(1, (now - g.start) / Math.max(1, g.ms));
  const e = t * t * (3 - 2 * t); // ease in-out, like the canvas crossfade
  for (const p of inst.params.list) {
    if (!(p.key in g.to)) continue;
    const a = g.from[p.key];
    const b = g.to[p.key];
    let v = b;
    if (t < 1 && p.kind === 'color') {
      const [ca, cb] = [rgb(a), rgb(b)];
      v = hex(ca.map((x, i) => x + (cb[i] - x) * e));
    } else if (t < 1) {
      v = a + (b - a) * e;
      if (Number.isInteger(p.step) && Number.isInteger(a) && Number.isInteger(b)) v = Math.round(v);
    }
    setValue(inst, p.key, v);
  }
  if (t >= 1) inst.glide = null;
  updateStreams();
}

/** The entry file of a scene of this dev server ('main.js' unless the list says otherwise). */
async function sceneModule(name) {
  if (!rt.scenes.some((s) => s.name === name)) rt.scenes = await localScenes(true).catch(() => rt.scenes);
  const info = rt.scenes.find((s) => s.name === name);
  if (!info) throw new Error(`Szene „${name}“ gibt es auf diesem Dev-Server nicht`);
  const file = `/scenes/${name}/${info.entry ?? 'main.js'}`;
  return { info, mod: loaders ? await loaders[file]() : await import(/* @vite-ignore */ file) };
}

// ---------- render loop ----------

function renderInstance(inst, now, dt) {
  sizeCanvas(inst);
  const ctx = inst.ctx;
  ctx.dt = dt;
  ctx.time = (now - inst.started) / 1000;
  ctx.frame = inst.frame++;
  if (inst.cameraAttached) camera.update(now, ctx.width, ctx.height);
  const r = inst.def.frame?.(ctx);
  if (r && typeof r.then === 'function') r.catch((e) => pushError('frame()', e));
}

/** A scene's wall map before its frame(): the camera's view, the room, the people (once per frame). */
function syncWall(inst, now) {
  const w = inst.wall;
  if (w.syncedAt === now) return;
  w.syncedAt = now;
  w.setRays(kinect.lut?.data);
  w.active = isWall(inst);
  w.update(kinect.view, xSign, now);
  wallPointer(inst);
}

/** The mouse on the wall (wall scenes): canvas pixels are LED pixels. */
function wallPointer(inst) {
  const p = inst.wall.pointer;
  if (!isWall(inst) || !inst.ctx) {
    p.inside = false;
    return;
  }
  const c = inst.ctx;
  p.u = c.pointer.x / Math.max(1, c.width);
  p.v = c.pointer.y / Math.max(1, c.height);
  [p.x, p.y] = inst.wall.fromUv(p.u, p.v);
  p.down = c.pointer.down;
  p.inside = p.u >= 0 && p.u < 1 && p.v >= 0 && p.v < 1;
}

// ---------- pages nobody sees ----------

/** A page hidden this long (background tab, minimized window) unsubscribes the Kinect streams. */
const HIDDEN_GRACE_MS = 3000;
let pageHidden = false;
let hiddenTimer = 0;
function watchVisibility() {
  clearTimeout(hiddenTimer);
  if (document.visibilityState === 'hidden') {
    hiddenTimer = setTimeout(() => {
      pageHidden = true;
      updateStreams();
    }, HIDDEN_GRACE_MS);
  } else if (pageHidden) {
    pageHidden = false;
    updateStreams();
  }
}
document.addEventListener('visibilitychange', watchVisibility);
watchVisibility();

// ---------- render reports (the hub's pose model gives way to a slow visible scene) ----------

// the display's refresh rate, from the intervals between animation frames (a low percentile: the
// frames that came in time), snapped to a usual rate
const REFRESH_RATES = [30, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
const rafIntervals = [];
let rafLast = 0;
function noteAnimationFrame(now) {
  if (rafLast) rafIntervals.push(now - rafLast);
  if (rafIntervals.length > 120) rafIntervals.shift();
  rafLast = now;
}
function refreshRate() {
  if (rafIntervals.length < 20) return 60;
  const sorted = [...rafIntervals].sort((x, y) => x - y);
  const hz = 1000 / Math.max(1, sorted[Math.floor(sorted.length * 0.1)]);
  return REFRESH_RATES.reduce((best, r) => (Math.abs(r - hz) / r < Math.abs(best - hz) / best ? r : best), 60);
}
setInterval(() => {
  const inst = rt.current;
  if (!inst || rt.state !== 'running') return;
  const refresh = refreshRate();
  const cap = FPS_CAP || inst.def.maxFps || 0;
  kinect.reportRender({
    fps: Math.round(rt.fps * 10) / 10,
    target: cap > 0 ? Math.min(cap, refresh) : refresh,
    visible: document.visibilityState === 'visible',
    scene: inst.name,
  });
}, 1000);

let lastFrame = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  noteAnimationFrame(now);
  const inst = rt.current;
  // optional render rate cap (scene maxFps or ?fps=): leaves GPU time for the Kinect depth decoding
  const cap = FPS_CAP || inst?.def.maxFps || 0;
  if (cap > 0 && now - lastFrame < 1000 / cap - 2) {
    updateHud(now);
    return;
  }
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  kinect.xSign = xSign;
  kinect.beginFrame(now);
  if (kinect.fresh.meta) camera.track(kinect.meta?.stats?.median_mm);
  wall.setRays(kinect.lut?.data); // the camera's real view, once the hub sent it
  if (wall.tanH !== rt.tanH) {
    rt.tanH = wall.tanH; // projections that follow the view cone ('cone') follow the real view
    applyWall();
  }
  wall.active = OUTPUT;
  wall.update(kinect.view, xSign, now);
  for (const i of liveInstances()) syncWall(i, now);
  hooks.beforeFrame?.(now);
  // scenes fading out (crossfade) render below the new one until the fade is over
  for (const l of [...rt.leaving]) {
    if (now >= l.until) {
      rt.leaving.splice(rt.leaving.indexOf(l), 1);
      destroy(l.inst);
      updateStreams();
      continue;
    }
    try {
      renderInstance(l.inst, now, dt);
    } catch (e) {
      rt.leaving.splice(rt.leaving.indexOf(l), 1);
      destroy(l.inst);
      console.warn('leaving scene', e);
    }
  }
  if (inst?.glide) stepGlide(inst, now);
  if (inst && rt.state === 'running') {
    try {
      renderInstance(inst, now, dt);
      rt.frames++;
      rt.fpsCount++;
      maybeThumb(now, inst);
    } catch (e) {
      rt.state = 'error';
      pushError('frame()', e);
    }
  }
  // same task as the rendering: the WebGPU drawing buffers can still be read (previews)
  hooks.afterFrame?.(now, inst);
  if (now - rt.fpsSince >= 1000) {
    rt.fps = (rt.fpsCount * 1000) / (now - rt.fpsSince);
    rt.fpsCount = 0;
    rt.fpsSince = now;
  }
  updateHud(now);
}

// ---------- thumbnails (gallery) ----------

let thumbAt = 0;
function scheduleThumb() {
  if (THUMBS) thumbAt = performance.now() + 3500;
}

function maybeThumb(now, inst) {
  if (!thumbAt || now < thumbAt) return;
  if (!kinect.depth && now < thumbAt + 6000) return; // wait for data, but not forever
  thumbAt = 0;
  try {
    const w = 480;
    const h = Math.max(1, Math.round((w * inst.canvas.height) / inst.canvas.width));
    const c = el('canvas');
    c.width = w;
    c.height = h;
    // same task as the rendering, so the WebGPU/WebGL drawing buffer is still there
    c.getContext('2d').drawImage(inst.canvas, 0, 0, w, h);
    c.toBlob((blob) => {
      if (blob) fetch(`/__thumb/${inst.name}`, { method: 'POST', body: blob }).catch(() => {});
    }, 'image/jpeg', 0.85);
  } catch (e) {
    console.warn('thumbnail', e);
  }
}

// ---------- HUD, keys ----------

let lastHud = 0;
let lastMove = performance.now();
addEventListener('pointermove', () => {
  lastMove = performance.now();
});

let slowSince = 0;
function sensorLine(now) {
  if (!kinect.connected) return `Keine Verbindung zu kinect-hub (${HUB}) – verbinde neu …`;
  const s = kinect.status?.sensor;
  if (s && s.state !== 'streaming') return `Kinect: ${s.state}${s.detail ? ` (${s.detail})` : ''}`;
  if (kinect.depth && kinect.ageMs(kinect.depth) > 1500) return `Keine neuen Bilder seit ${(kinect.ageMs(kinect.depth) / 1000).toFixed(0)} s`;
  // the depth decoding runs on the same GPU as this page: a GPU-hungry scene slows the sensor down
  const hubFps = kinect.status?.fps ?? 30;
  if (kinect.received > 60 && hubFps < 22) slowSince ||= now;
  else slowSince = 0;
  if (slowSince && now - slowSince > 3000) {
    return `Kinect nur ${hubFps.toFixed(0)} fps – GPU überlastet? Die Tiefenberechnung teilt sich die GPU mit dieser Szene (?fps=30 oder weniger Last)`;
  }
  return '';
}

function personsActive() {
  return !!kinect._personStream?.enabled;
}

function updateHud(now) {
  if (now - lastHud < 250) return;
  lastHud = now;
  const problem = sensorLine(now) || (personsActive() && kinect.personTracker.error ? kinect.personTracker.statusText : '');
  rt.problem = problem;
  banner.textContent = problem;
  banner.style.display = problem && !KIOSK ? 'block' : 'none';
  hud.classList.toggle('k-idle', now - lastMove > 4000);
  document.documentElement.classList.toggle('k-cursor-idle', OUTPUT && now - lastMove > 2000);
  if (uiHidden) return;
  const name = rt.current?.name ?? URL_NAME;
  const dev = devServer();
  const line1 = `${rt.title}${rt.title !== name ? `  (${name})` : ''}${dev?.label ? `  ·  ${dev.label}` : ''}`;
  const line2 = [
    `${rt.fps.toFixed(0)} fps`,
    `Kinect ${kinect.fps.toFixed(1)} fps`,
    kinect.latencyMs ? `Latenz ${kinect.latencyMs.toFixed(0)} ms` : null,
    personsActive() ? kinect.personTracker.statusText : null,
    rt.current?.ctx.status || null,
  ]
    .filter(Boolean)
    .join('  ·  ');
  hud.replaceChildren();
  el('div', 'k-hud-title', hud, line1);
  el('div', '', hud, line2);
  if (isWall(rt.current)) {
    const w = rt.current.wall;
    const s = w.setup;
    const F = w.projection.field;
    const own = projections.scenes[rt.current.name] || rt.current.def.projection ? 'eigene' : 'Standard';
    const gain = (t) => w.gain((F.nearL + F.nearR + (F.farL + F.farR - F.nearL - F.nearR) * t) / 2, F.near + (F.far - F.near) * t).toFixed(1);
    el('div', '', hud, `LED-Wand ${s.led.w}×${s.led.h} · ${s.size.w}×${s.size.h} m · Projektion: ${own}, quer ×${gain(0)} vorne … ×${gain(1)} hinten${w.projection.mirror ? ' · gespiegelt' : ''} · Setup: ${{ devserver: 'gemeinsam', local: 'nur dieser Browser', none: 'Standard' }[rt.setupSource] ?? rt.setupSource}`);
  }
  const keys = el('div', 'k-hud-keys', hud, 'h UI · f Vollbild · m Spiegeln · , . Szene · ');
  const a = el('a', '', keys, 'Galerie');
  a.href = '/';
  if (isWall(rt.current)) {
    keys.append(' · ');
    const c = el('a', '', keys, 'Steuerzentrale');
    c.href = '/control/';
  }
}

function applyUi() {
  document.documentElement.classList.toggle('k-ui-hidden', uiHidden);
  panel.setVisible(!uiHidden);
}

async function go(delta) {
  const name = rt.current?.name ?? URL_NAME;
  const here = `${location.origin}|${name}`;
  let list = (await allDevServers(HUB)).flatMap((s) => (s.scenes ?? []).map((sc) => ({ key: `${s.url}|${sc.name}`, url: sc.url })));
  if (!list.some((e) => e.key === here)) {
    list = (await localScenes().catch(() => [])).map((sc) => ({ key: `${location.origin}|${sc.name}`, url: `/scenes/${sc.name}/` }));
  }
  if (list.length < 2) return;
  const i = Math.max(0, list.findIndex((e) => e.key === here));
  const next = list[(i + delta + list.length) % list.length];
  const keep = new URLSearchParams();
  if (KIOSK) keep.set('kiosk', '');
  location.href = next.url + (keep.size ? `?${keep}`.replace('=', '') : '');
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

addEventListener('keydown', (e) => {
  if (e.target?.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (OUTPUT) {
    // the output window: only fullscreen (everything else comes from the control center)
    if (e.key === 'f' || e.key === 'F11') {
      e.preventDefault();
      toggleFullscreen();
    }
    return;
  }
  switch (e.key) {
    case 'h':
      if (KIOSK) return;
      uiHidden = !uiHidden;
      store('kinect:uiHidden', uiHidden);
      applyUi();
      break;
    case 'f':
      toggleFullscreen();
      break;
    case 'm':
      xSign = -xSign;
      store('kinect:xSign', xSign);
      break;
    case ',':
    case 'PageUp':
      go(-1);
      break;
    case '.':
    case 'PageDown':
      go(1);
      break;
    default:
      return;
  }
});

// ---------- boot ----------

async function refreshInfo() {
  try {
    rt.scenes = await localScenes(true);
    const info = rt.scenes.find((s) => s.name === (rt.current?.name ?? URL_NAME));
    if (info) {
      rt.info = info;
      rt.title = info.title || info.name;
      if (!OUTPUT) document.title = `${rt.title} · Kinect`;
    }
  } catch {
    // keep the old title
  }
}

function showMissing(list, reason) {
  rt.state = 'error';
  const box = el('div', 'k-missing', document.body);
  el('h1', '', box, reason);
  el('p', '', box, 'Vorhandene Szenen:');
  for (const s of list) {
    const a = el('a', '', el('div', '', box), `${s.name} – ${s.title}`);
    a.href = `/scenes/${s.name}/`;
  }
  const back = el('a', '', el('p', '', box), '← Galerie');
  back.href = '/';
}

/** Output window: plays a scene of this dev server in place (crossfade). For lib/wall-output.js. */
async function play(name, { overrides = null, transition = 'cross', fade = 1 } = {}) {
  if (rt.current?.name === name && rt.state === 'running') {
    // the same scene again (another show entry of it, ▶ on the one that runs, a command sent twice):
    // no second instance (see launch()), the running one takes the new values instead
    retune(rt.current, overrides, transition === 'cross' ? fade : 0);
    return true;
  }
  let found;
  try {
    found = await sceneModule(name);
  } catch (e) {
    pushError(`Szene ${name}`, e);
    return false;
  }
  rt.info = found.info;
  rt.title = found.info.title || name;
  return launch(found.mod, { name, overrides, transition: rt.current ? transition : 'cut', fade });
}

async function boot() {
  applyUi();
  await loadSetup().catch((e) => pushError('LED-Wand-Setup', e));
  await loadProjections().catch((e) => pushError('Projektion', e));
  if (OUTPUT) {
    document.title = 'LED-Wand · Ausgabe';
    rt.scenes = await localScenes(true).catch(() => []);
    const { startOutput } = await import('./wall-output.js');
    startOutput(outputApi);
    return;
  }
  let list = [];
  try {
    list = await localScenes(true);
  } catch (e) {
    pushError('Szenenliste', e);
  }
  rt.scenes = list;
  const info = list.find((s) => s.name === URL_NAME);
  if (!URL_NAME || !info) {
    showMissing(list, URL_NAME ? `Szene „${URL_NAME}“ gibt es nicht` : 'Keine Szene gewählt');
    return;
  }
  rt.info = info;
  rt.title = info.title || URL_NAME;
  document.title = `${rt.title} · Kinect`;
  let found;
  try {
    found = await sceneModule(URL_NAME);
  } catch (e) {
    rt.state = 'error';
    pushError(`Import von /scenes/${URL_NAME}/${info.entry}`, e);
    return;
  }
  await launch(found.mod, { name: URL_NAME });
}

function status() {
  return {
    scene: rt.current?.name ?? URL_NAME,
    title: rt.title,
    state: rt.state,
    frames: rt.frames,
    fps: Math.round(rt.fps * 10) / 10,
    swaps: rt.swaps,
    size: rt.current ? [rt.current.ctx.width, rt.current.ctx.height] : null,
    params: rt.current ? { ...rt.current.params.values } : null,
    wall: isWall(rt.current) ? { led: [wall.setup.led.w, wall.setup.led.h], output: OUTPUT, setup: rt.setupSource, projection: (rt.current?.wall ?? wall).projection } : null,
    errors: rt.errors.map(({ where, message, stack, count }) => ({ where, message, stack, count })),
    kinect: {
      hub: HUB,
      connected: kinect.connected,
      sensor: kinect.sensorState,
      hubFps: kinect.status?.fps ?? null,
      fps: Math.round(kinect.fps * 10) / 10,
      received: kinect.received,
      latencyMs: Math.round(kinect.latencyMs * 10) / 10,
    },
    persons: personsActive()
      ? {
          results: kinect.personTracker.results,
          count: kinect.persons?.list.length ?? 0,
          floor: kinect.persons?.floor ? Math.round(kinect.persons.floor.height * 100) / 100 : null,
          ms: kinect.persons ? Math.round(kinect.persons.ms * 10) / 10 : null,
          poseMs: kinect.persons ? Math.round(kinect.persons.poseMs * 10) / 10 : null,
          poseRuns: kinect.persons?.poseRuns ?? 0,
          seq: kinect.persons?.seq ?? null,
          mode: kinect.personTracker.options.mode ?? 'full',
          live: kinect.personTracker.dual, // live + exact: waitMs is how long the exact results take
          delayMs: kinect.persons ? Math.round(kinect.persons.lag) : null,
          waitMs: kinect.personTracker.waitStats(),
          provider: kinect.personTracker.provider,
          error: kinect.personTracker.error ? String(kinect.personTracker.error) : null,
        }
      : null,
  };
}

/** What lib/wall-output.js may use. */
const outputApi = {
  embedded: EMBED,
  owner: OWNER,
  kinect,
  wall,
  bus,
  rt,
  stage,
  hooks,
  play,
  status,
  pushError,
  updateStreams,
  personsActive,
  get xSign() {
    return xSign;
  },
  /** The wall map of the scene on the wall (its projection), else the page's. */
  sceneWall() {
    return rt.current?.wall ?? wall;
  },
  /** Retry a scene stopped by an error in frame(). */
  resume() {
    if (rt.current && rt.state === 'error') rt.state = 'running';
  },
  /** New param values for the running scene (a show entry's; missing ones get the defaults), at once. */
  setParams(overrides) {
    if (rt.current) retune(rt.current, overrides);
  },
  /** Stops every scene (black). */
  stop() {
    for (const l of rt.leaving.splice(0)) destroy(l.inst);
    if (rt.current) destroy(rt.current);
    rt.current = null;
    rt.state = 'loading';
  },
  loadSetup,
  loadProjections,
};

globalThis.__kinectRuntime = {
  hotSwap(mod, url) {
    // the module of a scene that is not shown any more (output window, after a switch) is ignored
    const name = /\/scenes\/([^/]+)\/main\.[jt]s/.exec(String(url ?? ''))?.[1];
    const inst = rt.pending ?? rt.current;
    if (name && inst && name !== inst.name) return false;
    return launch(mod, { name: inst?.name ?? URL_NAME, swap: true, overrides: inst?.overrides ?? null });
  },
  /** For debugging: what the scene sees as ctx.persons. */
  persons: () => kinect.view,
  /** For debugging: ctx.wall of the running scene. */
  wall: () => rt.current?.wall ?? wall,
  /** For tools/check.mjs and debugging. */
  status,
};

requestAnimationFrame(loop);
boot();
