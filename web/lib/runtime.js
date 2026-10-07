// runtime.js — runs one scene (scenes/<name>/main.js): canvas, render loop, Kinect data, parameter
// panel, HUD, error display and hot swap. Saving the scene replaces it in place; the hub connection,
// the GPU device, the camera and the parameter values stay. Scene API: ../AGENTS.md
//
// Keys of the runtime: h UI on/off · f fullscreen · m mirror · , . previous/next scene (all worktrees)
// URL options: ?hub=8091 (other hub) · ?kiosk (no UI at all) · ?fps=30 (cap the render rate)
//              · ?nothumb (no thumbnail upload)

import { KinectData, KinectGpu } from './kinect-data.js';
import { ParamPanel } from './params.js';
import { OrbitCamera } from './camera.js';
import { hubUrl, wsUrl, devServer, localScenes, allDevServers } from './hub.js';
import loaders from 'virtual:kinect-scene-loaders';
import './runtime.css';

const query = new URLSearchParams(location.search);
const NAME = decodeURIComponent(/\/scenes\/([^/]+)\/?/.exec(location.pathname)?.[1] ?? query.get('scene') ?? '');
const HUB = hubUrl();
const KIOSK = query.has('kiosk');
const THUMBS = !!devServer() && !query.has('nothumb');
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

const rt = {
  title: NAME,
  info: null,
  state: 'loading', // loading | running | error
  current: null, // the running scene instance
  pending: null, // an instance whose setup() is still running
  errors: [],
  frames: 0,
  swaps: 0,
  fps: 0,
  fpsCount: 0,
  fpsSince: performance.now(),
};

const kinect = new KinectData(wsUrl(HUB));
kinect.connect();
const camera = new OrbitCamera();
const panel = new ParamPanel();
let xSign = remember('kinect:xSign', -1) === 1 ? 1 : -1;
let uiHidden = KIOSK || remember('kinect:uiHidden', false) === true;

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
  } else {
    rt.errors.push({ where, message, stack: cleanStack(err?.stack), count: 1, at: Date.now() });
    if (rt.errors.length > 20) rt.errors.shift();
    console.error(`[${NAME}] ${where}:`, err);
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
  if (!rt.errors.length) return;
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

function createContext(inst) {
  const ctx = {
    scene: NAME,
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

function updateStreams() {
  const inst = rt.pending ?? rt.current;
  if (inst) kinect.setStreams(wantedStreams(inst));
}

function sizeCanvas(inst) {
  const ratio = inst.def.pixelRatio ?? Math.min(devicePixelRatio || 1, 2);
  let w = Math.max(1, Math.round(innerWidth * ratio));
  let h = Math.max(1, Math.round(innerHeight * ratio));
  const maxWidth = inst.def.maxWidth ?? 3840;
  if (w > maxWidth) {
    h = Math.max(1, Math.round((h * maxWidth) / w));
    w = maxWidth;
  }
  const ctx = inst.ctx;
  if (w === ctx.width && h === ctx.height) return;
  inst.canvas.width = w;
  inst.canvas.height = h;
  ctx.width = w;
  ctx.height = h;
  ctx.pixelRatio = w / Math.max(1, innerWidth);
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

async function launch(mod, { swap = false } = {}) {
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
  const inst = { def, canvas, dom, disposers: [], params: panel.resolve(NAME, def.params), started: performance.now(), frame: 0, ready: false };
  inst.ctx = createContext(inst);
  const ctx = inst.ctx;
  ctx.on(canvas, 'pointermove', (e) => {
    ctx.pointer.x = e.offsetX * ctx.pixelRatio;
    ctx.pointer.y = e.offsetY * ctx.pixelRatio;
  });
  ctx.on(canvas, 'pointerdown', () => (ctx.pointer.down = true));
  ctx.on(window, 'pointerup', () => (ctx.pointer.down = false));
  sizeCanvas(inst);
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
  panel.mount(inst.params, (key, value) => {
    try {
      def.onParam?.(key, value, ctx);
    } catch (e) {
      pushError('onParam()', e);
    }
    updateStreams();
  });
  if (old) destroy(old);
  rt.state = 'running';
  if (swap) rt.swaps++;
  clearErrors();
  scheduleThumb();
  return true;
}

// ---------- render loop ----------

let lastFrame = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const inst = rt.current;
  // optional render rate cap (scene maxFps or ?fps=): leaves GPU time for the Kinect depth decoding
  const cap = FPS_CAP || inst?.def.maxFps || 0;
  if (cap > 0 && now - lastFrame < 1000 / cap - 2) {
    updateHud(now);
    return;
  }
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  kinect.beginFrame(now);
  if (kinect.fresh.meta) camera.track(kinect.meta?.stats?.median_mm);
  if (inst && rt.state === 'running') {
    sizeCanvas(inst);
    const ctx = inst.ctx;
    ctx.dt = dt;
    ctx.time = (now - inst.started) / 1000;
    ctx.frame = inst.frame++;
    if (inst.cameraAttached) camera.update(now, ctx.width, ctx.height);
    try {
      const r = inst.def.frame?.(ctx);
      if (r && typeof r.then === 'function') r.catch((e) => pushError('frame()', e));
      rt.frames++;
      rt.fpsCount++;
      maybeThumb(now, inst);
    } catch (e) {
      rt.state = 'error';
      pushError('frame()', e);
    }
  }
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
      if (blob) fetch(`/__thumb/${NAME}`, { method: 'POST', body: blob }).catch(() => {});
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
  banner.textContent = problem;
  banner.style.display = problem && !KIOSK ? 'block' : 'none';
  hud.classList.toggle('k-idle', now - lastMove > 4000);
  if (uiHidden) return;
  const dev = devServer();
  const line1 = `${rt.title}${rt.title !== NAME ? `  (${NAME})` : ''}${dev?.label ? `  ·  ${dev.label}` : ''}`;
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
  const keys = el('div', 'k-hud-keys', hud, 'h UI · f Vollbild · m Spiegeln · , . Szene · ');
  const a = el('a', '', keys, 'Galerie');
  a.href = '/';
}

function applyUi() {
  document.documentElement.classList.toggle('k-ui-hidden', uiHidden);
  panel.setVisible(!uiHidden);
}

async function go(delta) {
  const here = `${location.origin}|${NAME}`;
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

addEventListener('keydown', (e) => {
  if (e.target?.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case 'h':
      if (KIOSK) return;
      uiHidden = !uiHidden;
      store('kinect:uiHidden', uiHidden);
      applyUi();
      break;
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => {});
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
    const info = (await localScenes()).find((s) => s.name === NAME);
    if (info) {
      rt.info = info;
      rt.title = info.title || NAME;
      document.title = `${rt.title} · Kinect`;
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

async function boot() {
  applyUi();
  let list = [];
  try {
    list = await localScenes();
  } catch (e) {
    pushError('Szenenliste', e);
  }
  const info = list.find((s) => s.name === NAME);
  if (!NAME || !info) {
    showMissing(list, NAME ? `Szene „${NAME}“ gibt es nicht` : 'Keine Szene gewählt');
    return;
  }
  rt.info = info;
  rt.title = info.title || NAME;
  document.title = `${rt.title} · Kinect`;
  const file = `/scenes/${NAME}/${info.entry}`;
  let mod;
  try {
    mod = loaders ? await loaders[file]() : await import(/* @vite-ignore */ file);
  } catch (e) {
    rt.state = 'error';
    pushError(`Import von ${file}`, e);
    return;
  }
  await launch(mod);
}

globalThis.__kinectRuntime = {
  hotSwap: (mod) => launch(mod, { swap: true }),
  /** For tools/check.mjs and debugging. */
  status: () => ({
    scene: NAME,
    title: rt.title,
    state: rt.state,
    frames: rt.frames,
    fps: Math.round(rt.fps * 10) / 10,
    swaps: rt.swaps,
    size: rt.current ? [rt.current.ctx.width, rt.current.ctx.height] : null,
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
          delayMs: kinect.persons ? Math.round(kinect.persons.lag) : null,
          waitMs: kinect.personTracker.waitStats(),
          provider: kinect.personTracker.provider,
          error: kinect.personTracker.error ? String(kinect.personTracker.error) : null,
        }
      : null,
  }),
};

requestAnimationFrame(loop);
boot();
