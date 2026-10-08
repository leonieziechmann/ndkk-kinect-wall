// control.js — the control center of the LED wall (/control/, see WALL.md). Runs the show of the
// output window (/wall/): what plays, the params of every entry, blackout, test images; edits the
// wall setup (with a top view of the room and the mapping); shows what the output reports.
// Talks to the output over the wall bus (lib/wall-bus.js); setup and show are saved by the dev
// server (shared by every worktree) and in localStorage.

import GUI from 'lil-gui';
import { WallBus, loadDoc, saveDoc, debounce } from './wall-bus.js';
import { WallMap, SETUP_FIELDS, WALL_DEFAULTS, normalizeSetup, getPath, setPath, manualRoom, inPolygon } from './wall.js';
import { normalizeShow, newEntry, PATTERNS, TRANSITIONS } from './wall-show.js';
import { normalizeParams, acceptsParam, readStore, storeKey } from './params.js';
import { hubUrl, getJson, localScenes, allDevServers, devServer } from './hub.js';
import './control.css';

const HUB = hubUrl();
const OUTPUT_ALIVE_MS = 2500;
const $ = (id) => document.getElementById(id);

function el(tag, className, parent, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const bus = new WallBus('control');
const state = {
  setup: normalizeSetup(null),
  setupSource: 'none',
  show: normalizeShow(null),
  scenes: [],
  outputs: new Map(), // page id -> { data, at }
  selected: null, // entry id whose params are shown
  follow: true, // the params follow the entry on the wall (until ✎ picks another one)
  hub: null,
};
const map = new WallMap();

// ---------- saving ----------

const saveSetup = debounce(async () => {
  state.setupSource = await saveDoc('setup', state.setup);
  renderSetupNote();
}, 400);
const saveShow = debounce(() => saveDoc('show', state.show), 400);
let lastLocalEdit = { setup: 0, show: 0 };

function setupChanged() {
  state.setup = normalizeSetup(state.setup);
  map.setSetup(state.setup);
  lastLocalEdit.setup = Date.now();
  bus.send('setup', { setup: state.setup });
  saveSetup();
  drawPlan();
}

function showChanged({ rerender = true } = {}) {
  state.show = normalizeShow(state.show);
  lastLocalEdit.show = Date.now();
  bus.send('show', { show: state.show }, 'output');
  saveShow();
  if (rerender) renderPlaylist();
}

// ---------- the output windows ----------

function outputs() {
  const now = Date.now();
  return [...state.outputs.entries()].filter(([, o]) => now - o.at < OUTPUT_ALIVE_MS).map(([id, o]) => ({ id, ...o.data }));
}
/** output windows (previews embedded in a control center do not count) */
const external = () => outputs().filter((o) => !o.embedded);
/** every output but the preview embedded in this page */
const others = () => outputs().filter((o) => o.owner !== bus.id);
/** the output whose state is shown: an output window, else another preview, else the one here */
const out = () => external()[0] ?? others()[0] ?? outputs()[0] ?? null;

bus.on('telemetry', (data, msg) => {
  state.outputs.set(msg.from, { data, at: Date.now() });
  renderLive();
});
bus.on('frame', (data) => {
  $('preview').src = data.jpeg;
  $('previewWrap').style.aspectRatio = `${data.w} / ${data.h}`;
});

// ---------- live preview embedded here (an output of its own, while no output window runs) ----------

const EMBED_KEY = 'kinect-wall:embed';
let embedFrame = null;
try {
  $('embedOn').checked = localStorage.getItem(EMBED_KEY) !== '0';
} catch {
  $('embedOn').checked = true;
}
$('embedOn').onchange = () => {
  try {
    localStorage.setItem(EMBED_KEY, $('embedOn').checked ? '1' : '0');
  } catch {
    // not remembered
  }
  syncEmbed();
};

// decided only after the outputs had a moment to report (no iframe that is gone again at once)
let embedReady = false;
setTimeout(() => {
  embedReady = true;
  syncEmbed();
}, 1200);

// a hidden tab stops its preview after a moment: its person tracking would keep the GPU busy
let hiddenSince = 0;
document.addEventListener('visibilitychange', () => {
  hiddenSince = document.visibilityState === 'hidden' ? performance.now() : 0;
  if (hiddenSince) setTimeout(syncEmbed, 3100);
  else syncEmbed();
});

function syncEmbed() {
  // at most one output per dev server: none here while a window or another tab's preview runs
  const visible = !hiddenSince || performance.now() - hiddenSince < 3000;
  // two tabs that started at the same time: the preview of the smaller page id stays
  const blockers = others().filter((o) => !o.embedded || !embedFrame || String(o.owner) < bus.id);
  const want = embedReady && visible && $('embedOn').checked && blockers.length === 0;
  if (want && !embedFrame) {
    const hub = new URLSearchParams(location.search).get('hub');
    embedFrame = el('iframe', '', $('embedBox'));
    embedFrame.title = 'Live-Vorschau der LED-Wand';
    embedFrame.src = `/wall/?embed&owner=${encodeURIComponent(bus.id)}${hub ? `&hub=${encodeURIComponent(hub)}` : ''}`;
  } else if (!want && embedFrame) {
    embedFrame.remove();
    embedFrame = null;
  }
  $('embedBox').hidden = !embedFrame;
  $('preview').hidden = !!embedFrame;
  if (embedFrame) $('previewWrap').style.aspectRatio = `${state.setup.led.w} / ${state.setup.led.h}`;
  $('embedNote').textContent = embedFrame
    ? '· läuft hier live (eigene Kinect-Verbindung und Personenerkennung)'
    : $('embedOn').checked && external().length
      ? '· aus, weil ein Ausgabefenster läuft (zeigt dessen Bild)'
      : $('embedOn').checked && others().length
        ? '· aus, weil die Vorschau schon in einem anderen Tab läuft (zeigt deren Bild)'
        : '';
}
// files changed by someone else (another control center, another worktree's dev server)
bus.on('file', async (d) => {
  if (Date.now() - (lastLocalEdit[d.kind] ?? 0) < 3000) return; // our own save
  if (d.kind === 'setup') await loadSetup();
  if (d.kind === 'show') await loadShow();
});
// another control center changed something live
bus.on('setup', (d) => {
  if (!d?.setup) return;
  state.setup = normalizeSetup(d.setup);
  map.setSetup(state.setup);
  setupGui?.refresh();
  renderBlocks();
  drawPlan();
});
bus.on('show', (d) => {
  state.show = normalizeShow(d.show);
  renderPlaylist();
  renderShowSettings();
});

setInterval(() => {
  if (document.visibilityState === 'visible') bus.send('preview', { on: true }, 'output');
}, 1000);
bus.send('ping', {}, 'output');

// ---------- header ----------

async function pollHub() {
  try {
    state.hub = await getJson(`${HUB}/api/status`, 1500);
  } catch {
    state.hub = null;
  }
  const pill = $('hubPill');
  const s = state.hub;
  if (!s) {
    pill.className = 'pill bad';
    pill.textContent = 'Hub getrennt';
  } else {
    const st = s.sensor?.state ?? '?';
    pill.className = `pill ${st === 'streaming' ? (s.fps < 22 ? 'warn' : 'ok') : 'warn'}`;
    pill.textContent = `Kinect ${st === 'streaming' ? `${s.fps.toFixed(0)} fps` : st}${s.source && s.source !== 'kinect' ? ` (${s.source})` : ''}`;
  }
  pill.title = HUB;
}
setInterval(pollHub, 2000);
pollHub();

$('openBtn').onclick = (e) => {
  e.stopPropagation();
  $('openMenu').hidden = !$('openMenu').hidden;
};
addEventListener('click', () => ($('openMenu').hidden = true));

$('openKiosk').onclick = async () => {
  try {
    const r = await fetch('/__wall/launch', { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    const info = await r.json();
    toast(info.window ? `Ausgabe startet auf ${info.window.label || `${info.window.left}, ${info.window.top}`}` : 'Ausgabe startet (kein Bildschirm gewählt: Wand-Setup → Bildschirm wählen)');
  } catch (e) {
    toast(`Kiosk-Fenster ging nicht: ${e.message}`, true);
  }
};
$('openWindow').onclick = () => {
  const w = state.setup.output.window;
  const features = w ? `popup,left=${w.left},top=${w.top},width=${w.width},height=${w.height}` : `popup,width=${Math.min(1400, state.setup.led.w + 40)},height=${state.setup.led.h + 80}`;
  const win = window.open('/wall/', 'kinect-wall-output', features);
  if (!win) toast('Popup blockiert – bitte Popups für diese Seite erlauben', true);
  else toast('Ausgabe geöffnet: im Fenster klicken oder f drücken = Vollbild');
};
$('reloadOut').onclick = () => bus.send('reload', {}, 'output');
$('closeOut').onclick = () => {
  bus.send('close', {}, 'output');
  fetch('/__wall/close', { method: 'POST' }).catch(() => {});
};

function setBlackout(on) {
  bus.send('blackout', { on }, 'output');
}
$('blackoutBtn').onclick = () => setBlackout(!out()?.blackout);
$('prevBtn').onclick = () => bus.send('prev', {}, 'output');
$('nextBtn').onclick = () => bus.send('next', {}, 'output');

for (const [name, label] of Object.entries(PATTERNS)) el('option', '', $('patternSel'), label).value = name;
const sendPattern = () => bus.send('pattern', { name: $('patternSel').value || null, over: $('patternOver').checked }, 'output');
$('patternSel').onchange = sendPattern;
$('patternOver').onchange = sendPattern;

addEventListener('keydown', (e) => {
  if (e.target?.closest?.('input, textarea, select, [contenteditable], .lil-gui') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'b' || e.key === 'B') setBlackout(!out()?.blackout);
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') bus.send('next', {}, 'output');
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') bus.send('prev', {}, 'output');
  else return;
  e.preventDefault();
});

let toastTimer = null;
function toast(text, bad = false) {
  let t = document.querySelector('.toast');
  if (!t) t = el('div', 'toast', document.body);
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

// ---------- tabs ----------

for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('active', x === b);
    for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== `tab-${b.dataset.tab}`;
    try {
      localStorage.setItem('kinect-wall:tab', b.dataset.tab);
    } catch {
      // not remembered
    }
    if (b.dataset.tab === 'setup') drawPlan();
  };
}
try {
  const tab = localStorage.getItem('kinect-wall:tab');
  document.querySelector(`.tabs button[data-tab="${tab}"]`)?.click();
} catch {
  // first tab
}

// ---------- live: what the output shows ----------

let lastLiveKey = '';
let booted = false; // show and scenes loaded: the playing entry may be selected
function renderLive() {
  syncEmbed();
  const windows = external();
  const o = out();
  const pill = $('outPill');
  if (!o) {
    pill.className = 'pill bad';
    pill.textContent = 'keine Ausgabe';
    $('previewNote').hidden = !!embedFrame;
    $('previewNote').textContent = 'Keine Ausgabe verbunden – „Ausgabe öffnen“ oder die Live-Vorschau einschalten';
    $('preview').removeAttribute('src');
  } else {
    pill.className = `pill ${o.problem || o.errors?.length ? 'warn' : 'ok'}`;
    pill.textContent = o.embedded ? `Vorschau hier ${o.fps.toFixed(0)} fps` : `Ausgabe ${o.fps.toFixed(0)} fps${windows.length > 1 ? ` (${windows.length} Fenster)` : ''}`;
    pill.title = o.problem ?? '';
    $('previewNote').hidden = !!embedFrame || !!$('preview').getAttribute('src');
  }
  $('peoplePill').textContent = o ? `${o.persons.length} Person${o.persons.length === 1 ? '' : 'en'}` : '–';
  $('previewBadge').hidden = !o?.blackout;
  $('blackoutBtn').classList.toggle('on', !!o?.blackout);
  const entry = state.show.entries.find((e) => e.id === o?.entry);
  $('nowTitle').textContent = o ? (entry?.label || o.title || o.scene || 'nichts') : '–';
  const meta = [];
  if (o?.scene) meta.push(o.scene);
  if (o?.state === 'switching') meta.push('wechselt …');
  else if (o?.state === 'error') meta.push('Fehler – neuer Versuch …');
  if (o?.elapsed != null && o.scene) meta.push(`läuft ${fmtTime(o.elapsed)}`);
  if (o?.remaining != null) meta.push(o.waiting ? 'wartet, bis niemand davor steht' : `weiter in ${fmtTime(o.remaining)}`);
  if (o?.entryRemoved) meta.push('nicht mehr im Ablauf');
  $('nowMeta').textContent = meta.join(' · ');
  $('nowStatus').textContent = o?.status ?? '';
  if (o && document.activeElement !== $('patternSel')) {
    $('patternSel').value = o.pattern ?? '';
    $('patternOver').checked = !!o.over;
  }
  const key = `${o?.entry}|${o?.scene}`;
  if (key !== lastLiveKey) {
    lastLiveKey = key;
    renderPlaylist();
    if (booted && (state.follow || !state.selected) && o?.entry && o.entry !== state.selected) selectEntry(o.entry);
  }
  renderStatus(o);
  if (!$('tab-setup').hidden) drawPlan();
}
setInterval(renderLive, 1000);

// ---------- show: playlist ----------

function sceneInfo(name) {
  return state.scenes.find((s) => s.name === name) ?? null;
}

function renderPlaylist() {
  const root = $('playlist');
  root.replaceChildren();
  const playing = out()?.entry;
  if (!state.show.entries.length) {
    el('div', 'empty', root, 'Noch leer: unten Szenen mit „+“ hinzufügen.');
  }
  state.show.entries.forEach((e, i) => {
    const row = el('div', `entry${e.id === playing ? ' playing' : ''}${e.id === state.selected ? ' selected' : ''}${e.enabled ? '' : ' disabled'}`, root);
    const play = el('button', 'icon play', row, e.id === playing ? '●' : '▶');
    play.title = 'Jetzt zeigen';
    play.onclick = () => bus.send('play', { entry: e.id }, 'output');
    const main = el('div', 'entry-main', row);
    const label = el('input', 'entry-label', main);
    label.value = e.label;
    label.placeholder = sceneInfo(e.scene)?.title ?? e.scene;
    label.onchange = () => {
      e.label = label.value;
      showChanged({ rerender: false });
    };
    const info = sceneInfo(e.scene);
    const sub = el('div', 'entry-sub muted', main, `${e.scene}${info ? '' : ' – fehlt auf diesem Dev-Server'}${Object.keys(e.params).length ? ` · ${Object.keys(e.params).length} Werte angepasst` : ''}`);
    if (!info) sub.classList.add('bad-text');
    const dur = el('label', 'entry-dur', row);
    const di = el('input', '', dur);
    di.type = 'number';
    di.min = '0.1';
    di.step = '0.5';
    di.value = String(Math.round((e.duration / 60) * 10) / 10);
    di.title = 'Dauer in Minuten (automatisch weiter)';
    di.onchange = () => {
      e.duration = Math.max(5, (Number(di.value) || 5) * 60);
      showChanged({ rerender: false });
    };
    el('span', 'muted', dur, 'min');
    const en = el('input', '', row);
    en.type = 'checkbox';
    en.checked = e.enabled;
    en.title = 'im automatischen Ablauf';
    en.onchange = () => {
      e.enabled = en.checked;
      showChanged();
    };
    const edit = el('button', 'icon', row, '✎');
    edit.title = 'Parameter';
    edit.onclick = () => {
      state.follow = e.id === playing;
      selectEntry(e.id);
    };
    const up = el('button', 'icon', row, '↑');
    up.disabled = i === 0;
    up.onclick = () => move(i, -1);
    const down = el('button', 'icon', row, '↓');
    down.disabled = i === state.show.entries.length - 1;
    down.onclick = () => move(i, 1);
    const dup = el('button', 'icon', row, '⧉');
    dup.title = 'Duplizieren (z. B. andere Werte)';
    dup.onclick = () => {
      const copy = { ...newEntry(e.scene, e.label ? `${e.label} (2)` : ''), duration: e.duration, params: { ...e.params } };
      state.show.entries.splice(i + 1, 0, copy);
      showChanged();
    };
    const del = el('button', 'icon', row, '✕');
    del.title = 'Entfernen';
    del.onclick = () => {
      if (!confirm(`„${e.label || info?.title || e.scene}“ aus dem Ablauf entfernen?`)) return;
      state.show.entries.splice(i, 1);
      if (state.selected === e.id) selectEntry(null);
      showChanged();
    };
  });
}

function move(i, d) {
  const list = state.show.entries;
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  showChanged();
}

function renderShowSettings() {
  const s = state.show;
  $('autoOn').checked = s.auto;
  $('waitEmpty').checked = s.waitForEmpty;
  $('maxWait').value = String(s.maxWait);
  $('transSel').value = s.transition;
  $('fadeSec').value = String(s.fade);
}
for (const [label, value] of Object.entries(TRANSITIONS)) el('option', '', $('transSel'), label).value = value;
$('autoOn').onchange = () => {
  state.show.auto = $('autoOn').checked;
  showChanged({ rerender: false });
};
$('waitEmpty').onchange = () => {
  state.show.waitForEmpty = $('waitEmpty').checked;
  showChanged({ rerender: false });
};
$('maxWait').onchange = () => {
  state.show.maxWait = Number($('maxWait').value) || 0;
  showChanged({ rerender: false });
};
$('transSel').onchange = () => {
  state.show.transition = $('transSel').value;
  showChanged({ rerender: false });
};
$('fadeSec').onchange = () => {
  state.show.fade = Number($('fadeSec').value) || 0;
  showChanged({ rerender: false });
};

// ---------- scene library ----------

async function loadScenes() {
  try {
    state.scenes = await localScenes(true);
  } catch {
    state.scenes = [];
  }
  const root = $('library');
  root.replaceChildren();
  const own = state.scenes.filter((s) => s.changed).length;
  $('libNote').textContent = `${state.scenes.length} auf diesem Dev-Server${devServer()?.filtered ? ` (${own} von diesem Worktree)` : ''}`;
  for (const s of state.scenes) {
    const card = el('div', 'scene', root);
    const thumb = el('div', 'scene-thumb', card);
    if (s.thumb) thumb.style.backgroundImage = `url("${s.thumb}")`;
    const body = el('div', 'scene-body', card);
    const t = el('div', 'scene-title', body, s.title);
    if (s.changed && devServer()?.filtered) el('span', 'badge', t, 'neu/geändert');
    el('div', 'muted scene-desc', body, s.description || s.name);
    const add = el('button', 'btn small', card, '+');
    add.title = 'Zum Ablauf hinzufügen';
    add.onclick = () => {
      const e = newEntry(s.name);
      state.show.entries.push(e);
      showChanged();
      selectEntry(e.id);
    };
    const look = el('button', 'btn small scene-play', card, '▶');
    look.title = 'Jetzt auf der Wand zeigen, ohne sie in den Ablauf aufzunehmen';
    look.onclick = () => bus.send('play', { scene: s.name }, 'output');
    const open = el('a', 'scene-open', card, '↗');
    open.href = `/scenes/${s.name}/`;
    open.target = '_blank';
    open.title = 'Szenen-Seite öffnen (Vorschau, eigene Werte)';
  }
  renderPlaylist();
  // the other dev servers: their scenes play in their own control center
  const others = (await allDevServers(HUB)).filter((d) => d.url !== location.origin && d.url !== devServer()?.url);
  const o = $('others');
  o.replaceChildren();
  if (others.length) {
    el('span', '', o, 'Andere Worktrees (eigene Steuerzentrale, eigener Dev-Server): ');
    others.forEach((d, i) => {
      if (i) o.append(' · ');
      const a = el('a', '', o, `${d.label || d.url} (${d.scenes?.length ?? 0})`);
      a.href = `${d.url}/control/`;
    });
  }
}
if (import.meta.hot) import.meta.hot.on('kinect:scenes', loadScenes);

// ---------- params of a show entry ----------

let paramGui = null;
let paramToken = 0;

async function selectEntry(id) {
  state.selected = id;
  renderPlaylist();
  paramGui?.destroy();
  paramGui = null;
  const token = ++paramToken;
  const entry = state.show.entries.find((e) => e.id === id);
  $('paramsActions').hidden = !entry;
  if (!entry) {
    $('paramsHead').textContent = 'Parameter';
    $('paramsNote').textContent = 'Einen Eintrag im Ablauf wählen (✎).';
    return;
  }
  const info = sceneInfo(entry.scene);
  $('paramsHead').textContent = `Parameter: ${entry.label || info?.title || entry.scene}${entry.id === out()?.entry ? ' (läuft)' : ''}`;
  $('paramsNote').textContent = 'lädt …';
  let specs;
  let wall = false;
  try {
    // the scene module only declares itself on import; its setup() is not run here
    const mod = await import(/* @vite-ignore */ `/scenes/${entry.scene}/${info?.entry ?? 'main.js'}`);
    specs = normalizeParams((mod.default ?? mod).params);
    wall = !!(mod.default ?? mod).wall;
  } catch (e) {
    if (token === paramToken) $('paramsNote').textContent = `Szene lässt sich nicht laden: ${e.message}`;
    return;
  }
  if (token !== paramToken) return;
  $('paramsNote').textContent = `${specs.length ? 'Änderungen gelten sofort auf der Wand, wenn dieser Eintrag läuft, und werden gespeichert.' : 'Diese Szene hat keine Parameter.'}${wall ? '' : ' Die Szene ist nicht für die LED-Wand gebaut (kein wall: true) – sie wird trotzdem in LED-Auflösung gezeigt.'}`;
  if (!specs.length) return;
  const values = {};
  for (const p of specs) values[p.key] = p.key in entry.params && acceptsParam(p, entry.params[p.key]) ? entry.params[p.key] : p.value;
  const gui = new GUI({ container: $('paramsGui'), title: entry.scene });
  gui.domElement.classList.add('kinect-params');
  gui.domElement.style.width = '100%';
  const folders = new Map();
  const controllers = [];
  for (const p of specs) {
    let parent = gui;
    if (p.folder) {
      if (!folders.has(p.folder)) folders.set(p.folder, gui.addFolder(p.folder));
      parent = folders.get(p.folder);
    }
    let c;
    if (p.kind === 'number') c = parent.add(values, p.key, p.min, p.max, p.step);
    else if (p.kind === 'color') c = parent.addColor(values, p.key);
    else if (p.kind === 'select') c = parent.add(values, p.key, p.options);
    else c = parent.add(values, p.key);
    c.name(p.label);
    const mark = () => c.domElement.classList.toggle('changed', values[p.key] !== p.value);
    mark();
    c.onChange((v) => {
      if (v === p.value) delete entry.params[p.key];
      else entry.params[p.key] = v;
      mark();
      showChanged({ rerender: false });
    });
    controllers.push({ c, p, mark });
  }
  paramGui = gui;
  $('paramsReset').onclick = () => {
    entry.params = {};
    for (const { c, p, mark } of controllers) {
      values[p.key] = p.value;
      c.updateDisplay();
      mark();
    }
    showChanged();
  };
  $('paramsFromPage').onclick = () => {
    // what the scene's own page (/scenes/<name>/) remembers in this browser
    const stored = readStore(storeKey(entry.scene));
    let n = 0;
    for (const { c, p, mark } of controllers) {
      if (!(p.key in stored) || !acceptsParam(p, stored[p.key])) continue;
      values[p.key] = stored[p.key];
      if (stored[p.key] === p.value) delete entry.params[p.key];
      else entry.params[p.key] = stored[p.key];
      c.updateDisplay();
      mark();
      n++;
    }
    showChanged();
    toast(n ? `${n} Werte von der Szenen-Seite übernommen` : 'Die Szenen-Seite hat in diesem Browser keine eigenen Werte');
  };
}

// ---------- wall setup ----------

let setupGui = null;

function buildSetupGui() {
  setupGui?.destroy();
  const gui = new GUI({ container: $('setupGui'), title: 'Einstellungen' });
  gui.domElement.classList.add('kinect-params');
  gui.domElement.style.width = '100%';
  const folders = new Map();
  const proxies = [];
  for (const f of SETUP_FIELDS) {
    if (!folders.has(f.group)) folders.set(f.group, gui.addFolder(f.group));
    const proxy = { v: getPath(state.setup, f.key) };
    let c;
    if (f.kind === 'select') c = folders.get(f.group).add(proxy, 'v', f.options);
    else if (f.kind === 'boolean') c = folders.get(f.group).add(proxy, 'v');
    else c = folders.get(f.group).add(proxy, 'v', f.min, f.max, f.step);
    c.name(f.label);
    const def = getPath(WALL_DEFAULTS, f.key);
    const mark = () => c.domElement.classList.toggle('changed', proxy.v !== def);
    mark();
    c.onChange((v) => {
      setPath(state.setup, f.key, v);
      mark();
      setupChanged();
      showRelevant();
    });
    proxies.push({ f, proxy, c, mark });
  }
  // only what matters for the chosen mapping
  function showRelevant() {
    const s = state.setup;
    for (const { f, c } of proxies) {
      let show = true;
      if (f.key === 'map.factor') show = s.map.mode === 'factor';
      if (f.key === 'map.depth') show = s.map.mode === 'fit';
      if (f.key === 'map.distance') show = s.map.mode !== 'real';
      if (f.key === 'map.margin' || f.key === 'map.clamp') show = s.map.apply === 'person';
      if (f.key === 'sensor.height' || f.key === 'sensor.tilt') show = s.sensor.floor === 'manual' || !out()?.room?.found;
      if (f.key === 'output.x' || f.key === 'output.y') show = s.output.fit === 'pixel';
      c.show(show);
    }
  }
  showRelevant();
  gui.refresh = () => {
    for (const { f, proxy, c, mark } of proxies) {
      proxy.v = getPath(state.setup, f.key);
      c.updateDisplay();
      mark();
    }
    showRelevant();
    renderScreenNote();
  };
  setupGui = gui;
  return gui;
}

function renderSetupNote() {
  $('setupNote').textContent = {
    devserver: '· gespeichert für alle Worktrees (web/.cache/wall/setup.json im Haupt-Checkout)',
    local: '· nur in diesem Browser gespeichert (kein Dev-Server)',
    none: '· Standardwerte',
  }[state.setupSource] ?? '';
}

function renderScreenNote() {
  const w = state.setup.output.window;
  $('screenNote').textContent = w ? `Ausgabe auf: ${w.label || 'Bildschirm'} (${w.width}×${w.height} bei ${w.left}, ${w.top})` : 'kein Bildschirm gewählt';
}

$('screenBtn').onclick = async () => {
  const root = $('screens');
  root.replaceChildren();
  if (!('getScreenDetails' in window)) {
    el('div', 'muted', root, 'Dieser Browser kann keine Bildschirme auflisten (Chrome/Edge können es). Das Kiosk-Fenster öffnet dann dort, wo der Browser will.');
    return;
  }
  let details;
  try {
    details = await window.getScreenDetails();
  } catch (e) {
    el('div', 'muted', root, `Keine Erlaubnis für die Bildschirme (${e.message}). In der Adressleiste erlauben und nochmal versuchen.`);
    return;
  }
  for (const sc of details.screens) {
    const b = el('button', 'btn small screen', root, `${sc.label || 'Bildschirm'} · ${sc.width}×${sc.height} bei ${sc.left}, ${sc.top}${sc.isPrimary ? ' · Hauptbildschirm' : ''}${sc.devicePixelRatio !== 1 ? ` · Skalierung ${Math.round(sc.devicePixelRatio * 100)} %!` : ''}`);
    b.onclick = () => {
      const dpr = sc.devicePixelRatio || 1;
      state.setup.output.window = { left: Math.round(sc.left * dpr), top: Math.round(sc.top * dpr), width: Math.round(sc.width * dpr), height: Math.round(sc.height * dpr), label: sc.label || '' };
      setupChanged();
      renderScreenNote();
      root.replaceChildren();
      if (dpr !== 1) toast('Dieser Bildschirm ist skaliert: für pixelgenaue Ausgabe in Windows auf 100 % stellen', true);
    };
  }
  const none = el('button', 'btn small', root, 'keinen');
  none.onclick = () => {
    state.setup.output.window = null;
    setupChanged();
    renderScreenNote();
    root.replaceChildren();
  };
};

$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify({ setup: state.setup, show: state.show }, null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `led-wand-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const file = $('importFile').files?.[0];
  if (!file) return;
  try {
    const doc = JSON.parse(await file.text());
    if (doc.setup) {
      state.setup = normalizeSetup(doc.setup);
      setupGui.refresh();
      setupChanged();
      renderBlocks();
    }
    if (doc.show) {
      state.show = normalizeShow(doc.show);
      showChanged();
      renderShowSettings();
    }
    toast('Importiert');
  } catch (e) {
    toast(`Import fehlgeschlagen: ${e.message}`, true);
  }
  $('importFile').value = '';
};
$('defaultsBtn').onclick = () => {
  if (!confirm('Wand-Setup auf die Standardwerte (6 × 2 m, 1008 × 336) zurücksetzen? Bildschirm und Sperrzonen bleiben.')) return;
  state.setup = normalizeSetup({ output: { window: state.setup.output.window }, blocks: state.setup.blocks });
  setupGui.refresh();
  setupChanged();
};

// ---------- top view of the room: mapping, room picture, block zones ----------

// the plan's transform (set by drawPlan): floor plan m (x from the wall's left edge, z in front of
// the wall) <-> canvas CSS px
const view = { ox: 0, oy: 14, scale: 50, w: 0, h: 0 };
const toPx = (x, z) => [view.ox + x * view.scale, view.oy + z * view.scale];
const toPlan = (px, py) => [(px - view.ox) / view.scale, (py - view.oy) / view.scale];
const BLOCK_RGB = '255, 59, 79';
const edit = { drawing: null, drag: null, hover: null, selected: null, mouse: null }; // block zone editing
let roomShot = null; // the floor plan: { x0, z0, nx, nz, hits, top, floor, at, source } (see loadRoomShot)
let shotCanvas = null;
let shotKey = '';

// The floor plan of the room: one depth frame of the hub, every point put on the floor (orthographic,
// from straight above) into cells of 5 cm. A cell is drawn when something stands there between
// 15 cm and 2 m above the floor (walls, tables, other stations, people): a wall becomes a line, a
// table a block. The floor the sensor sees is shown faintly; the ceiling is left out.
const PLAN_CELL = 0.05; // m
const OBSTACLE = [0.15, 2.0]; // m above the floor
async function loadRoomShot() {
  const o = out();
  const hub = o?.kinect?.hub ?? HUB;
  $('planNote').textContent = 'lade Grundriss …';
  try {
    const r = await fetch(`${hub}/api/frame/points`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const pts = new Int16Array(await r.arrayBuffer());
    // the room as the output sees it (floor found by the person tracking), else the sensor by hand
    const s = state.setup;
    const xSign = o?.xSign ?? -1;
    const m = o?.room?.matrix?.length === 16 ? o.room.matrix : manualRoom(s.sensor.height, s.sensor.tilt);
    const x0 = -4;
    const z0 = 0;
    const nx = Math.ceil((s.size.w + 8) / PLAN_CELL);
    const nz = Math.ceil((s.sensor.front + 9) / PLAN_CELL);
    const hits = new Uint16Array(nx * nz); // points between OBSTACLE[0] and OBSTACLE[1]
    const top = new Float32Array(nx * nz); // the highest of them
    const floor = new Uint16Array(nx * nz); // points on the floor
    for (let k = 0; k < pts.length; k += 3) {
      const z = pts[k + 2];
      if (!z) continue;
      const wx = (xSign * pts[k]) / 1000;
      const wy = -pts[k + 1] / 1000;
      const wz = z / 1000;
      const ry = m[1] * wx + m[5] * wy + m[9] * wz + m[13]; // height above the floor
      if (ry > OBSTACLE[1] || ry < -0.15) continue;
      const rx = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
      const rz = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
      const cx = Math.floor((s.size.w / 2 + s.sensor.x + xSign * rx - x0) / PLAN_CELL);
      const cz = Math.floor((s.sensor.front + rz - z0) / PLAN_CELL);
      if (cx < 0 || cx >= nx || cz < 0 || cz >= nz) continue;
      const c = cz * nx + cx;
      if (ry < OBSTACLE[0]) floor[c]++;
      else {
        hits[c]++;
        if (ry > top[c]) top[c] = ry;
      }
    }
    roomShot = { x0, z0, nx, nz, hits, top, floor, at: Date.now(), source: o?.room?.found ? 'erkannter Boden' : 'Boden von Hand' };
    shotKey = '';
    $('planNote').textContent = `Grundriss von ${new Date().toLocaleTimeString()} (${roomShot.source})`;
  } catch (e) {
    $('planNote').textContent = `Grundriss ging nicht: ${e.message} (läuft der Hub?)`;
  }
  drawPlan();
}
$('shotBtn').onclick = loadRoomShot;

/** the floor plan at the current transform (cached): cells colored by how high things stand there */
function shotLayer(cssW, cssH, dpr) {
  if (!roomShot) return null;
  const key = `${cssW}x${cssH}@${dpr}:${view.ox.toFixed(2)},${view.scale.toFixed(3)}:${roomShot.at}`;
  if (key === shotKey && shotCanvas) return shotCanvas;
  shotKey = key;
  shotCanvas ??= document.createElement('canvas');
  shotCanvas.width = Math.round(cssW * dpr);
  shotCanvas.height = Math.round(cssH * dpr);
  const g = shotCanvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  const { x0, z0, nx, nz, hits, top, floor } = roomShot;
  const size = PLAN_CELL * view.scale + 0.5; // a hair larger: no seams between cells
  for (let cz = 0; cz < nz; cz++) {
    for (let cx = 0; cx < nx; cx++) {
      const c = cz * nx + cx;
      if (!hits[c] && !floor[c]) continue;
      const [px, py] = toPx(x0 + cx * PLAN_CELL, z0 + cz * PLAN_CELL);
      if (px > cssW || py > cssH || px + size < 0 || py + size < 0) continue;
      if (hits[c] >= 2) {
        // low (tables, chairs) dark teal .. tall (walls, stations, people) light
        const t = Math.min(1, (top[c] - OBSTACLE[0]) / (OBSTACLE[1] - OBSTACLE[0]));
        g.fillStyle = `rgb(${Math.round(40 + 170 * t)}, ${Math.round(120 + 110 * t)}, ${Math.round(140 + 100 * t)})`;
      } else if (floor[c]) g.fillStyle = 'rgba(110, 130, 170, 0.16)';
      else continue;
      g.fillRect(px, py, size, size);
    }
  }
  return shotCanvas;
}

function drawPlan() {
  const canvas = $('plan');
  if (!canvas || $('tab-setup').hidden) return;
  const cssW = canvas.clientWidth || 600;
  const s = state.setup;
  const o = out();
  map.setSetup(s);
  if (o?.tanH) map.tanH = o.tanH;
  const depth = s.zone.far + s.sensor.front + 0.5;
  const spanW = Math.max(s.size.w, 2 * (s.zone.far * map.tanH) + 1) + 1;
  const ppm = cssW / spanW;
  const cssH = Math.round(Math.min(560, (depth + 0.6) * ppm));
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
  }
  view.scale = Math.min(ppm, (cssH - 20) / depth);
  view.ox = cssW / 2 - (s.size.w / 2) * view.scale;
  view.oy = 14;
  view.w = cssW;
  view.h = cssH;
  const scale = view.scale;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#101014';
  g.fillRect(0, 0, cssW, cssH);
  const X = (x) => view.ox + x * scale;
  const Y = (z) => view.oy + z * scale;
  // the floor plan of the room, then a 1 m grid over it (true to scale: x and z alike)
  const shot = shotLayer(cssW, cssH, dpr);
  if (shot) g.drawImage(shot, 0, 0, cssW, cssH);
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.lineWidth = 1;
  g.fillStyle = '#5a5a68';
  g.font = '11px system-ui, sans-serif';
  for (let x = Math.ceil(-view.ox / scale); x * scale + view.ox < cssW; x++) {
    g.beginPath();
    g.moveTo(X(x) + 0.5, Y(0));
    g.lineTo(X(x) + 0.5, cssH);
    g.stroke();
    g.fillText(`${x} m`, X(x) + 3, cssH - 4);
  }
  for (let z = 1; Y(z) < cssH - 14; z++) {
    g.beginPath();
    g.moveTo(0, Y(z) + 0.5);
    g.lineTo(cssW, Y(z) + 0.5);
    g.stroke();
    g.fillText(`${z} m`, 4, Y(z) - 3);
  }
  // the sensor's view (gray) and the zone (lighter)
  const sx = s.size.w / 2 + s.sensor.x;
  const sz = s.sensor.front;
  const t = map.tanH;
  const wedge = (z0, z1, fill) => {
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(X(sx - z0 * t), Y(sz + z0));
    g.lineTo(X(sx + z0 * t), Y(sz + z0));
    g.lineTo(X(sx + z1 * t), Y(sz + z1));
    g.lineTo(X(sx - z1 * t), Y(sz + z1));
    g.closePath();
    g.fill();
  };
  wedge(s.zone.near, s.zone.far, 'rgba(120,170,255,0.08)');
  g.strokeStyle = 'rgba(255,255,255,0.28)';
  g.setLineDash([2, 3]);
  g.beginPath();
  for (const side of [-1, 1]) {
    g.moveTo(X(sx), Y(sz));
    g.lineTo(X(sx + side * depth * t), Y(sz + depth));
  }
  g.stroke();
  g.setLineDash([]);
  // the wall and the sensor
  g.fillStyle = '#8fc1ff';
  g.fillRect(X(0), Y(0) - 4, s.size.w * scale, 4);
  g.fillStyle = '#ddd';
  g.font = '12px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(`LED-Wand ${s.size.w} m`, X(s.size.w / 2), Y(0) - 7 < 10 ? Y(0) + 14 : Y(0) - 7);
  g.fillStyle = '#fff';
  g.fillRect(X(sx) - 6, Y(sz) - 3, 12, 6);
  // the mapping: where the view at the reference distance (and the zone's ends) lands on the wall
  const marks = s.map.mode === 'real' ? [s.zone.near, s.zone.far] : [s.zone.near, s.map.distance, s.zone.far];
  for (const d of marks) {
    const ref = d === s.map.distance && s.map.mode !== 'real';
    g.strokeStyle = ref ? 'rgba(255,220,120,0.9)' : 'rgba(255,255,255,0.25)';
    g.setLineDash(ref ? [5, 4] : [2, 4]);
    g.beginPath();
    g.moveTo(X(sx - d * t), Y(sz + d));
    g.lineTo(X(sx + d * t), Y(sz + d));
    for (const side of [-1, 1]) {
      const lat = side * d * t;
      let wx = s.size.w / 2 + s.sensor.x + lat * map.k(lat, d);
      if (s.map.apply === 'person' && s.map.clamp) wx = Math.min(s.size.w - s.map.margin, Math.max(s.map.margin, wx));
      g.moveTo(X(sx + lat), Y(sz + d));
      g.lineTo(X(wx), Y(0));
    }
    g.stroke();
    if (ref) {
      g.fillStyle = 'rgba(255,220,120,0.95)';
      g.textAlign = 'left';
      g.fillText(`${d} m · Faktor ${map.k(1, d).toFixed(2)}`, X(sx + d * t) + 6, Y(sz + d) + 4);
    }
  }
  g.setLineDash([]);
  drawBlocks(g);
  // the people: where they stand -> where the wall shows them
  for (const p of o?.persons ?? []) {
    const px = X(p.real);
    const py = Y(p.z);
    g.globalAlpha = p.inZone ? 1 : 0.4;
    g.strokeStyle = p.css ?? '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(X(p.x), Y(0));
    g.stroke();
    g.fillStyle = p.css ?? '#fff';
    g.beginPath();
    g.arc(px, py, 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.fillText(`${p.dist.toFixed(1)} m${Math.abs(p.shift) > 0.05 ? ` · ${p.shift > 0 ? '+' : ''}${p.shift.toFixed(1)} m` : ''}`, px + 10, py + 4);
    g.globalAlpha = 1;
  }
  // people standing in a block zone: not tracked (gray cross)
  for (const b of o?.blocked ?? []) {
    const [px, py] = toPx(b.x, b.z);
    g.strokeStyle = 'rgba(230,230,235,0.85)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px - 6, py - 6);
    g.lineTo(px + 6, py + 6);
    g.moveTo(px + 6, py - 6);
    g.lineTo(px - 6, py + 6);
    g.stroke();
    g.fillStyle = 'rgba(230,230,235,0.85)';
    g.textAlign = 'left';
    g.fillText('gesperrt', px + 10, py + 4);
  }
  g.textAlign = 'left';
  g.lineWidth = 1;
}
addEventListener('resize', drawPlan);

const polyPath = (g, points) => {
  g.beginPath();
  points.forEach(([x, z], i) => {
    const [px, py] = toPx(x, z);
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  });
};

function drawBlocks(g) {
  for (const b of state.setup.blocks) {
    const sel = edit.selected === b.id;
    polyPath(g, b.points);
    g.closePath();
    g.fillStyle = `rgba(${BLOCK_RGB}, ${b.enabled ? (sel ? 0.32 : 0.22) : 0.07})`;
    g.fill();
    g.setLineDash(b.enabled ? [] : [4, 4]);
    g.strokeStyle = `rgba(${BLOCK_RGB}, ${b.enabled ? 0.95 : 0.5})`;
    g.lineWidth = sel ? 2 : 1.5;
    g.stroke();
    g.setLineDash([]);
    b.points.forEach(([x, z], i) => {
      const [px, py] = toPx(x, z);
      const hot = edit.hover?.id === b.id && edit.hover.i === i;
      const r = hot ? 4 : 3;
      g.fillStyle = hot ? '#fff' : `rgb(${BLOCK_RGB})`;
      g.fillRect(px - r, py - r, 2 * r, 2 * r);
    });
    const c = b.points.reduce((a, p) => [a[0] + p[0] / b.points.length, a[1] + p[1] / b.points.length], [0, 0]);
    const [cx, cy] = toPx(c[0], c[1]);
    g.fillStyle = '#ffd0d5';
    g.font = '12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(b.name || 'Sperrzone', cx, cy + 4);
  }
  // the zone being drawn, with a line to the mouse
  const d = edit.drawing;
  if (d?.length) {
    polyPath(g, d);
    if (edit.mouse) g.lineTo(edit.mouse[0], edit.mouse[1]);
    g.fillStyle = `rgba(${BLOCK_RGB}, 0.15)`;
    if (d.length > 1) g.fill();
    g.strokeStyle = `rgb(${BLOCK_RGB})`;
    g.lineWidth = 2;
    g.stroke();
    d.forEach(([x, z], i) => {
      const [px, py] = toPx(x, z);
      g.fillStyle = i === 0 ? '#fff' : `rgb(${BLOCK_RGB})`;
      g.fillRect(px - 4, py - 4, 8, 8);
    });
  }
  g.textAlign = 'left';
}

function renderBlocks() {
  const root = $('blocks');
  root.replaceChildren();
  state.setup.blocks.forEach((b, i) => {
    const row = el('div', `block${edit.selected === b.id ? ' selected' : ''}`, root);
    el('span', 'swatch', row);
    const name = el('input', '', row);
    name.value = b.name;
    name.placeholder = `Sperrzone ${i + 1}`;
    name.onchange = () => {
      b.name = name.value;
      setupChanged();
    };
    const lab = el('label', 'muted', row);
    const on = el('input', '', lab);
    on.type = 'checkbox';
    on.checked = b.enabled;
    lab.append(' aktiv');
    on.onchange = () => {
      b.enabled = on.checked;
      setupChanged();
      drawPlan();
    };
    const del = el('button', 'icon', row, '✕');
    del.title = 'Löschen';
    del.onclick = () => {
      state.setup.blocks.splice(i, 1);
      if (edit.selected === b.id) edit.selected = null;
      setupChanged();
      renderBlocks();
    };
    row.onclick = (e) => {
      if (e.target.closest('input, button, label')) return;
      edit.selected = edit.selected === b.id ? null : b.id;
      renderBlocks();
      drawPlan();
    };
  });
}

/** the block zone corner under the mouse (within 9 px): { id, i } or null */
function cornerAt(px, py) {
  for (const b of state.setup.blocks) {
    for (let i = 0; i < b.points.length; i++) {
      const [x, y] = toPx(b.points[i][0], b.points[i][1]);
      if (Math.hypot(x - px, y - py) <= 9) return { id: b.id, i };
    }
  }
  return null;
}

function startDrawing() {
  edit.drawing = [];
  edit.selected = null;
  $('plan').classList.add('drawing');
  $('plan').focus({ preventScroll: true });
  $('blockBtn').textContent = 'Zeichnen abbrechen';
  $('planNote').textContent = 'Eckpunkte in die Draufsicht klicken · Doppelklick oder Klick auf den ersten Punkt schließt · Esc bricht ab';
  drawPlan();
}

function stopDrawing(save) {
  const pts = edit.drawing;
  edit.drawing = null;
  edit.mouse = null;
  $('plan').classList.remove('drawing');
  $('blockBtn').textContent = 'Sperrzone zeichnen';
  $('planNote').textContent = '';
  if (save && pts && pts.length >= 3) {
    const id = Math.random().toString(36).slice(2, 10);
    state.setup.blocks.push({ id, name: `Sperrzone ${state.setup.blocks.length + 1}`, enabled: true, points: pts });
    edit.selected = id;
    setupChanged(); // to every page at once, and saved
  }
  renderBlocks();
  drawPlan();
}

$('blockBtn').onclick = () => (edit.drawing ? stopDrawing(false) : startDrawing());

const planCanvas = $('plan');
const mouseOf = (e) => {
  const r = planCanvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
const roundPlan = (px, py) => toPlan(px, py).map((v) => Math.round(v * 100) / 100);

planCanvas.addEventListener('pointerdown', (e) => {
  const [px, py] = mouseOf(e);
  if (edit.drawing) {
    const first = edit.drawing[0];
    if (first && edit.drawing.length >= 3) {
      const [fx, fy] = toPx(first[0], first[1]);
      if (Math.hypot(fx - px, fy - py) <= 10) {
        stopDrawing(true);
        return;
      }
    }
    edit.drawing.push(roundPlan(px, py));
    drawPlan();
    return;
  }
  const hit = cornerAt(px, py);
  if (hit) {
    edit.drag = hit;
    edit.selected = hit.id;
    planCanvas.setPointerCapture(e.pointerId);
    renderBlocks();
    return;
  }
  // a click into a zone selects it (Entf deletes it)
  const [x, z] = toPlan(px, py);
  const inside = [...state.setup.blocks].reverse().find((b) => inPolygon(x, z, b.points));
  edit.selected = inside?.id ?? null;
  renderBlocks();
  drawPlan();
});

planCanvas.addEventListener('pointermove', (e) => {
  const [px, py] = mouseOf(e);
  if (edit.drawing) {
    edit.mouse = [px, py];
    drawPlan();
    return;
  }
  if (edit.drag) {
    const b = state.setup.blocks.find((z) => z.id === edit.drag.id);
    if (b) b.points[edit.drag.i] = roundPlan(px, py);
    drawPlan();
    return;
  }
  const hover = cornerAt(px, py);
  if (hover?.id !== edit.hover?.id || hover?.i !== edit.hover?.i) {
    edit.hover = hover;
    planCanvas.style.cursor = hover ? 'grab' : '';
    drawPlan();
  }
});

planCanvas.addEventListener('pointerup', () => {
  if (!edit.drag) return;
  edit.drag = null;
  setupChanged(); // to every page at once, and saved
});

planCanvas.addEventListener('dblclick', (e) => {
  if (!edit.drawing) return;
  e.preventDefault();
  // the double click added its point twice: drop the copy
  const d = edit.drawing;
  if (d.length >= 2 && d.at(-1)[0] === d.at(-2)[0] && d.at(-1)[1] === d.at(-2)[1]) d.pop();
  stopDrawing(true);
});

planCanvas.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && edit.drawing) stopDrawing(false);
  else if (e.key === 'Enter' && edit.drawing) stopDrawing(true);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && edit.selected && !edit.drawing) {
    state.setup.blocks = state.setup.blocks.filter((b) => b.id !== edit.selected);
    edit.selected = null;
    setupChanged();
    renderBlocks();
  } else return;
  e.preventDefault();
});

// ---------- status ----------

function renderStatus(o) {
  const t = $('statusTable');
  const rows = [];
  if (!o) rows.push(['Ausgabe', 'nicht verbunden']);
  else {
    rows.push(['Szene', `${o.title || '–'} (${o.scene ?? '–'})`]);
    rows.push(['Zustand', o.state]);
    rows.push(['Bildrate', `${o.fps} fps`]);
    const k = o.kinect;
    rows.push(['Kinect', k ? (k.connected ? `${k.fps} fps (Hub ${k.hubFps ?? '–'}), Latenz ${k.latencyMs} ms, ${k.sensor ?? ''}` : `keine Verbindung zu ${k.hub}`) : '–']);
    if (o.problem) rows.push(['Problem', o.problem]);
    rows.push(['Personen', `${o.persons.length}${o.tracker ? ` · ${o.tracker}` : ''}`]);
    rows.push(['Boden', o.room.found ? `erkannt: Kinect ${o.room.height.toFixed(2)} m hoch${o.room.pitch != null ? `, Neigung ${o.room.pitch.toFixed(1)}°` : ''}` : `von Hand: ${o.room.height} m`]);
    rows.push(['LED-Bild', `${o.led[0]} × ${o.led[1]}`]);
    const sc = o.screen;
    rows.push(['Bildschirm der Ausgabe', `${sc.w}×${sc.h}${sc.left != null ? ` bei ${sc.left}, ${sc.top}` : ''} · Fenster ${sc.inner[0]}×${sc.inner[1]} · Skalierung ${Math.round(sc.dpr * 100)} %${sc.fullscreen ? ' · Vollbild' : ''}`]);
    if (sc.dpr !== 1) rows.push(['Hinweis', 'Skalierung ≠ 100 %: Windows-Anzeige auf 100 % stellen oder das Kiosk-Fenster nutzen (erzwingt 1:1).']);
    rows.push(['Status der Szene', o.status || '–']);
  }
  t.replaceChildren();
  for (const [k, v] of rows) {
    const tr = el('tr', '', t);
    el('td', '', tr, k);
    el('td', '', tr, v);
  }
  const er = $('errors');
  er.replaceChildren();
  if (!o?.errors?.length) er.textContent = 'keine';
  for (const e of o?.errors ?? []) el('div', 'error', er, `${new Date(e.at).toLocaleTimeString()} · ${e.scene ?? ''} · ${e.where}${e.count > 1 ? ` (${e.count}×)` : ''}: ${e.message}`);
}

// ---------- start ----------

async function loadSetup() {
  const r = await loadDoc('setup');
  state.setup = normalizeSetup(r.doc);
  state.setupSource = r.source;
  map.setSetup(state.setup);
  if (setupGui) setupGui.refresh();
  else buildSetupGui();
  renderBlocks();
  renderSetupNote();
  renderScreenNote();
  drawPlan();
}

async function loadShow() {
  const r = await loadDoc('show');
  state.show = normalizeShow(r.doc);
  renderPlaylist();
  renderShowSettings();
  if (state.selected && !state.show.entries.some((e) => e.id === state.selected)) selectEntry(null);
}

/** For debugging and tests. */
globalThis.__wallControl = { state, toPx, toPlan, outputs, edit, view };

await Promise.all([loadSetup(), loadShow(), loadScenes()]);
booted = true;
const playing = out()?.entry;
selectEntry(state.show.entries.some((e) => e.id === playing) ? playing : null);
renderLive();
setTimeout(() => bus.send('ping', {}, 'output'), 500);
