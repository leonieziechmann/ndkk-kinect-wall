// app.js — the control center of the LED wall, served by the output itself (wall-bevy: src/control/).
// Runs the show (what plays, the params of every entry, blackout, test images), edits the projection
// of every scene (projection.js) and the wall setup (with a top view of the room and the block zones),
// shows what the output reports, and pairs phones and tablets as remote controls.
// Talks to the output over one WebSocket (link.js); the output keeps the documents (setup, projection,
// show) and passes every change on to the other open control centers.

import GUI from './gui.js';
import { Link } from './link.js';
import { WallMap, SETUP_FIELDS, WALL_DEFAULTS, normalizeSetup, getPath, setPath, manualRoom, inPolygon, coneAt } from './wall.js';
import { createProjectionTab } from './projection.js';
import { normalizeShow, newEntry, PATTERNS, TRANSITIONS } from './show.js';
import { normalizeParams, acceptsParam } from './params.js';

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

const link = new Link();
const state = {
  setup: normalizeSetup(null),
  show: normalizeShow(null),
  scenes: [], // the output's scenes: { name, title, params, projection, persons, streams, maxFps }
  telemetry: null, // what the output reports (4 times a second)
  telemetryAt: 0,
  selected: null, // entry id whose params are shown
  follow: true, // the params follow the entry on the wall (until ✎ picks another one)
  pairing: null, // { code, urls, local }
  local: false, // this page runs on the output's computer
  server: null, // { version, hub, data }
  booted: false,
};
const map = new WallMap();
/** the tab "Projektion" (projection.js), created further down */
let proj = null;

// ---------- sending changes ----------

/** fn(), right away and then at most every `ms` while it is called (sliders, dragging) */
function throttle(fn, ms) {
  let timer = 0;
  let pending = false;
  return () => {
    if (timer) {
      pending = true;
      return;
    }
    fn();
    timer = setTimeout(function again() {
      timer = 0;
      if (pending) {
        pending = false;
        fn();
        timer = setTimeout(again, ms);
      }
    }, ms);
  };
}

const sendSetup = throttle(() => link.send('doc', { kind: 'setup', doc: state.setup }), 50);
const sendShow = throttle(() => link.send('doc', { kind: 'show', doc: state.show }), 50);

function setupChanged() {
  state.setup = normalizeSetup(state.setup);
  map.setSetup(state.setup);
  sendSetup();
  proj?.setupChanged();
  drawPlan();
}

function showChanged({ rerender = true } = {}) {
  state.show = normalizeShow(state.show);
  sendShow();
  if (rerender) renderPlaylist();
}

// ---------- the output ----------

/** The output's state, while the connection stands. */
const out = () => (link.open && state.telemetry && Date.now() - state.telemetryAt < 3000 ? state.telemetry : null);

link.on('hello', (d) => {
  state.local = !!d.local;
  state.pairing = d.pairing ?? null;
  state.server = d.server ?? null;
  state.scenes = Array.isArray(d.catalog) ? d.catalog : [];
  if (d.telemetry && typeof d.telemetry === 'object' && Object.keys(d.telemetry).length) {
    state.telemetry = d.telemetry;
    state.telemetryAt = Date.now();
  }
  loadSetup(d.docs?.setup);
  loadShow(d.docs?.show);
  proj.load(d.docs?.projection);
  renderLibrary();
  renderPairing();
  if (!state.booted) {
    state.booted = true;
    const o = out();
    proj.select(o?.scene && state.scenes.some((x) => x.name === o.scene) ? o.scene : '');
    selectEntry(state.show.entries.some((e) => e.id === o?.entry) ? o.entry : null);
  } else if (state.selected) selectEntry(state.selected);
  renderLive();
});

link.on('telemetry', (d) => {
  state.telemetry = d;
  state.telemetryAt = Date.now();
  renderLive();
  proj?.tick();
});

let frameUrl = null;
link.on('frame', (buf) => {
  const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
  const img = $('preview');
  img.onload = () => {
    if (frameUrl && frameUrl !== url) URL.revokeObjectURL(frameUrl);
    frameUrl = url;
  };
  img.src = url;
});

// changed by another control center (or by hand in the file)
link.on('doc', (d) => {
  if (d.kind === 'setup') {
    state.setup = normalizeSetup(d.doc);
    map.setSetup(state.setup);
    setupGui?.refresh();
    renderBlocks();
    proj?.setupChanged();
    drawPlan();
  } else if (d.kind === 'show') {
    state.show = normalizeShow(d.doc);
    renderPlaylist();
    renderShowSettings();
  }
});

// a scene library came new (or a new scene): the list, the params
link.on('catalog', (d) => {
  state.scenes = Array.isArray(d.scenes) ? d.scenes : [];
  renderLibrary();
  renderPlaylist();
  proj?.scenesChanged();
  if (state.selected) selectEntry(state.selected);
});

link.on('pairing', (d) => {
  state.pairing = d;
  renderPairing();
});

link.on('note', (d) => toast(d.text, !!d.bad));
link.on('open', () => renderLive());
link.on('close', () => renderLive());

// the preview pictures while this page is seen
setInterval(() => {
  if (document.visibilityState === 'visible' && !$('previewWrap').hidden) link.send('preview', { on: true });
}, 1000);

// ---------- header ----------

function renderPills(o) {
  const hub = $('hubPill');
  const k = o?.kinect;
  if (!link.open) {
    hub.className = 'pill bad';
    hub.textContent = 'Ausgabe getrennt';
  } else if (!k) {
    hub.className = 'pill';
    hub.textContent = 'Kinect …';
  } else if (!k.connected) {
    hub.className = 'pill bad';
    hub.textContent = 'Hub getrennt';
  } else {
    const st = k.sensor ?? '?';
    hub.className = `pill ${st === 'streaming' ? ((k.hubFps ?? k.fps) < 22 ? 'warn' : 'ok') : 'warn'}`;
    hub.textContent = `Kinect ${st === 'streaming' ? `${Math.round(k.hubFps ?? k.fps)} fps` : st}`;
  }
  hub.title = k?.hub ?? '';
  const pill = $('outPill');
  if (!o) {
    pill.className = 'pill bad';
    pill.textContent = link.open ? 'Ausgabe …' : 'keine Verbindung';
  } else {
    pill.className = `pill ${o.problem || o.errors?.length ? 'warn' : 'ok'}`;
    pill.textContent = `Ausgabe ${Math.round(o.fps)} fps`;
    pill.title = o.problem ?? '';
  }
  $('peoplePill').textContent = o ? `${o.persons.length} Person${o.persons.length === 1 ? '' : 'en'}` : '–';
}

function setBlackout(on) {
  link.send('blackout', { on });
}
$('blackoutBtn').onclick = () => setBlackout(!out()?.blackout);
$('prevBtn').onclick = () => link.send('prev');
$('nextBtn').onclick = () => link.send('next');

for (const [name, label] of Object.entries(PATTERNS)) el('option', '', $('patternSel'), label).value = name;
const sendPattern = () => link.send('pattern', { name: $('patternSel').value || null, over: $('patternOver').checked });
$('patternSel').onchange = sendPattern;
$('patternOver').onchange = sendPattern;

addEventListener('keydown', (e) => {
  if (e.target?.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'b' || e.key === 'B') setBlackout(!out()?.blackout);
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') link.send('next');
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') link.send('prev');
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
    if (b.dataset.tab === 'projection') proj?.render();
  };
}
try {
  const tab = localStorage.getItem('kinect-wall:tab');
  document.querySelector(`.tabs button[data-tab="${tab}"]`)?.click();
} catch {
  // first tab
}

// the preview can be hidden (a phone as a plain remote: less traffic)
const PREVIEW_KEY = 'kinect-wall:preview';
function setPreviewShown(on) {
  $('previewWrap').hidden = !on;
  $('previewToggle').textContent = on ? 'Vorschau aus' : 'Vorschau an';
  try {
    localStorage.setItem(PREVIEW_KEY, on ? '1' : '0');
  } catch {
    // not remembered
  }
}
$('previewToggle').onclick = () => setPreviewShown($('previewWrap').hidden);
try {
  setPreviewShown(localStorage.getItem(PREVIEW_KEY) !== '0');
} catch {
  setPreviewShown(true);
}

// ---------- live: what the output shows ----------

let lastLiveKey = '';
function renderLive() {
  const o = out();
  renderPills(o);
  $('previewNote').hidden = !!o && !!$('preview').getAttribute('src');
  $('previewNote').textContent = link.open ? 'Warte auf die Ausgabe …' : 'Keine Verbindung zur Ausgabe – verbinde neu …';
  if (!o) $('preview').removeAttribute('src');
  if (o?.led) $('previewWrap').style.aspectRatio = `${o.led[0]} / ${o.led[1]}`;
  $('previewBadge').hidden = !o?.blackout;
  $('blackoutBtn').classList.toggle('on', !!o?.blackout);
  const entry = state.show.entries.find((e) => e.id === o?.entry);
  $('nowTitle').textContent = o ? entry?.label || o.title || o.scene || 'nichts' : '–';
  const meta = [];
  if (o?.scene) meta.push(o.scene);
  if (o?.state === 'switching') meta.push('wechselt …');
  else if (o?.state === 'error') meta.push('Fehler – neuer Versuch …');
  if (o?.elapsed != null && o.scene) meta.push(`läuft ${fmtTime(o.elapsed)}`);
  if (o?.remaining != null && o.waiting) {
    const why = o.waiting === 'round' ? 'wartet auf Rundenende' : 'wartet, bis niemand davor steht';
    const limit = o.waiting === 'empty' && o.waitLimit != null ? ` · Grenze ${fmtTime(o.waitLimit)} bei ${o.crowd} Person${o.crowd === 1 ? '' : 'en'}` : '';
    meta.push(o.waitLeft > 0 ? `${why} (höchstens noch ${fmtTime(Math.ceil(o.waitLeft))}${limit})` : why);
  } else if (o?.remaining != null) meta.push(`weiter in ${fmtTime(o.remaining)}`);
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
    if (state.booted && (state.follow || !state.selected) && o?.entry && o.entry !== state.selected) selectEntry(o.entry);
  }
  renderStatus(o);
  renderScreens();
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
    play.onclick = () => link.send('play', { entry: e.id });
    const main = el('div', 'entry-main', row);
    const label = el('input', 'entry-label', main);
    label.value = e.label;
    label.placeholder = sceneInfo(e.scene)?.title ?? e.scene;
    label.onchange = () => {
      e.label = label.value;
      showChanged({ rerender: false });
    };
    const info = sceneInfo(e.scene);
    const sub = el('div', 'entry-sub muted', main, `${e.scene}${info ? '' : ' – gibt es in der Ausgabe nicht'}${e.wait ? '' : ' · pünktlich'}${Object.keys(e.params).length ? ` · ${Object.keys(e.params).length} Werte angepasst` : ''}`);
    if (!info) sub.classList.add('bad-text');
    const tools = el('div', 'entry-tools', row);
    const dur = el('label', 'entry-dur', tools);
    const di = el('input', '', dur);
    di.type = 'number';
    di.min = '0.1';
    di.step = '0.5';
    di.inputMode = 'decimal';
    di.value = String(Math.round((e.duration / 60) * 10) / 10);
    di.title = 'Dauer in Minuten (automatisch weiter)';
    di.onchange = () => {
      e.duration = Math.max(5, (Number(di.value) || 5) * 60);
      showChanged({ rerender: false });
    };
    el('span', 'muted', dur, 'min');
    const wait = el('button', `icon wait${e.wait ? '' : ' punctual'}`, tools, '⧗');
    wait.title = e.wait
      ? 'Darf überziehen: wartet nach der Dauer, bis niemand davor steht bzw. die Runde endet (Klick: pünktlich)'
      : 'Pünktlich: wechselt genau nach der Dauer, auch wenn jemand davor steht, z. B. Werbung (Klick: darf überziehen)';
    wait.onclick = () => {
      e.wait = !e.wait;
      showChanged();
    };
    const en = el('input', '', tools);
    en.type = 'checkbox';
    en.checked = e.enabled;
    en.title = 'im automatischen Ablauf';
    en.onchange = () => {
      e.enabled = en.checked;
      showChanged();
    };
    const edit = el('button', 'icon', tools, '✎');
    edit.title = 'Parameter';
    edit.onclick = () => {
      state.follow = e.id === playing;
      selectEntry(e.id);
      // on a narrow screen the params are below the list
      if (matchMedia('(max-width: 900px)').matches) $('paramsHead').scrollIntoView({ behavior: 'smooth' });
    };
    const up = el('button', 'icon', tools, '↑');
    up.title = 'Nach oben';
    up.disabled = i === 0;
    up.onclick = () => move(i, -1);
    const down = el('button', 'icon', tools, '↓');
    down.title = 'Nach unten';
    down.disabled = i === state.show.entries.length - 1;
    down.onclick = () => move(i, 1);
    const dup = el('button', 'icon', tools, '⧉');
    dup.title = 'Duplizieren (z. B. andere Werte)';
    dup.onclick = () => {
      const copy = { ...newEntry(e.scene, e.label ? `${e.label} (2)` : ''), duration: e.duration, wait: e.wait, params: { ...e.params } };
      state.show.entries.splice(i + 1, 0, copy);
      showChanged();
    };
    const del = el('button', 'icon', tools, '✕');
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
  $('maxWaitMany').value = String(s.maxWaitMany);
  $('manyPersons').value = String(s.manyPersons);
  $('waitRound').checked = s.waitForRound;
  $('maxRoundWait').value = String(s.maxRoundWait);
  $('transSel').value = s.transition;
  $('fadeSec').value = String(s.fade);
}
for (const [label, value] of Object.entries(TRANSITIONS)) el('option', '', $('transSel'), label).value = value;
const showSetting = (id, apply) => {
  $(id).onchange = () => {
    apply($(id));
    showChanged({ rerender: false });
  };
};
showSetting('autoOn', (x) => (state.show.auto = x.checked));
showSetting('waitEmpty', (x) => (state.show.waitForEmpty = x.checked));
showSetting('maxWait', (x) => (state.show.maxWait = Number(x.value) || 0));
showSetting('maxWaitMany', (x) => (state.show.maxWaitMany = Number(x.value) || 0));
showSetting('manyPersons', (x) => (state.show.manyPersons = Math.max(2, Math.round(Number(x.value) || 10))));
showSetting('waitRound', (x) => (state.show.waitForRound = x.checked));
showSetting('maxRoundWait', (x) => (state.show.maxRoundWait = Number(x.value) || 0));
showSetting('transSel', (x) => (state.show.transition = x.value));
showSetting('fadeSec', (x) => (state.show.fade = Number(x.value) || 0));

// ---------- the scenes ----------

function renderLibrary() {
  const root = $('library');
  root.replaceChildren();
  $('libNote').textContent = `${state.scenes.length} in der Ausgabe`;
  for (const s of state.scenes) {
    const card = el('div', 'scene', root);
    const body = el('div', 'scene-body', card);
    el('div', 'scene-title', body, s.title || s.name);
    const n = Array.isArray(s.params) ? s.params.length : 0;
    el('div', 'muted scene-desc', body, `${s.name}${n ? ` · ${n} Parameter` : ''}${s.persons ? '' : ' · ohne Personen'}`);
    const look = el('button', 'btn small scene-play', card, '▶');
    look.title = 'Jetzt auf der Wand zeigen, ohne sie in den Ablauf aufzunehmen';
    look.onclick = () => link.send('play', { scene: s.name });
    const add = el('button', 'btn small', card, '+');
    add.title = 'Zum Ablauf hinzufügen';
    add.onclick = () => {
      const e = newEntry(s.name);
      state.show.entries.push(e);
      showChanged();
      selectEntry(e.id);
      toast(`„${s.title || s.name}“ ist im Ablauf`);
    };
  }
}

// ---------- params of a show entry ----------

let paramGui = null;

function selectEntry(id) {
  state.selected = id;
  renderPlaylist();
  paramGui?.destroy();
  paramGui = null;
  const entry = state.show.entries.find((e) => e.id === id);
  $('paramsActions').hidden = !entry;
  if (!entry) {
    $('paramsHead').textContent = 'Parameter';
    $('paramsNote').textContent = 'Einen Eintrag im Ablauf wählen (✎).';
    return;
  }
  const info = sceneInfo(entry.scene);
  $('paramsHead').textContent = `Parameter: ${entry.label || info?.title || entry.scene}${entry.id === out()?.entry ? ' (läuft)' : ''}`;
  if (!info) {
    $('paramsNote').textContent = 'Diese Szene hat die Ausgabe nicht (mehr).';
    return;
  }
  const specs = normalizeParams(info.params);
  $('paramsNote').textContent = specs.length ? 'Änderungen gelten sofort auf der Wand, wenn dieser Eintrag läuft, und werden gespeichert.' : 'Diese Szene hat keine Parameter.';
  if (!specs.length) return;
  const values = {};
  for (const p of specs) values[p.key] = p.key in entry.params && acceptsParam(p, entry.params[p.key]) ? entry.params[p.key] : p.value;
  const gui = new GUI({ container: $('paramsGui'), title: info.title || entry.scene });
  gui.domElement.classList.add('kinect-params');
  const folders = new Map();
  const controllers = [];
  // a document from elsewhere replaces the entry objects in state.show: always write into the current one
  const current = () => state.show.entries.find((e) => e.id === id);
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
      const cur = current();
      if (!cur) return;
      const n = Object.keys(cur.params).length;
      if (v === p.value) delete cur.params[p.key];
      else cur.params[p.key] = v;
      mark();
      showChanged({ rerender: Object.keys(cur.params).length !== n }); // the row shows how many are adjusted
    });
    controllers.push({ c, p, mark });
  }
  paramGui = gui;
  $('paramsReset').onclick = () => {
    const cur = current();
    if (!cur) return;
    cur.params = {};
    for (const { c, p, mark } of controllers) {
      values[p.key] = p.value;
      c.updateDisplay();
      mark();
    }
    showChanged();
  };
}

// ---------- wall setup ----------

let setupGui = null;

function buildSetupGui() {
  setupGui?.destroy();
  const gui = new GUI({ container: $('setupGui'), title: 'Einstellungen' });
  gui.domElement.classList.add('kinect-params');
  const folders = new Map();
  const proxies = [];
  for (const f of SETUP_FIELDS) {
    if (f.legacy) continue;
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
  $('setupNote').textContent = state.server?.data ? `· gespeichert in der Ausgabe (${state.server.data})` : '';
}

function renderScreenNote() {
  const w = state.setup.output.window;
  $('screenNote').textContent = w ? `Ausgabe auf: ${w.label || 'Bildschirm'} (${w.width}×${w.height} bei ${w.left}, ${w.top})` : 'kein Bildschirm gewählt: der erste, der nicht der Hauptbildschirm ist';
}

/** the screens of the output's computer (telemetry): a click puts the output there */
let screensKey = '';
function renderScreens() {
  const list = out()?.monitors ?? [];
  const w = state.setup.output.window;
  const key = JSON.stringify([list, w]);
  if (key === screensKey) return;
  screensKey = key;
  const root = $('screens');
  root.replaceChildren();
  if (!list.length) {
    el('div', 'muted', root, link.open ? 'Die Ausgabe meldet noch keine Bildschirme.' : 'Keine Verbindung zur Ausgabe.');
    return;
  }
  for (const m of list) {
    const chosen = w && Math.abs(w.left - m.left) <= 2 && Math.abs(w.top - m.top) <= 2;
    const b = el('button', `btn small screen${chosen ? ' chosen' : ''}`, root, `${chosen ? '✓ ' : ''}${m.name || 'Bildschirm'} · ${m.width}×${m.height} bei ${m.left}, ${m.top}${m.primary ? ' · Hauptbildschirm' : ''}${m.scale !== 1 ? ` · Skalierung ${Math.round(m.scale * 100)} %` : ''}${m.hz ? ` · ${m.hz} Hz` : ''}`);
    b.onclick = () => {
      state.setup.output.window = { left: m.left, top: m.top, width: m.width, height: m.height, label: m.name || '' };
      setupChanged();
      renderScreenNote();
      renderScreens();
      if (m.primary) toast('Das ist der Hauptbildschirm (Notebook): die Ausgabe geht trotzdem dorthin', true);
    };
  }
  const none = el('button', 'btn small', root, 'automatisch');
  none.title = 'Der erste Bildschirm, der nicht der Hauptbildschirm ist';
  none.onclick = () => {
    state.setup.output.window = null;
    setupChanged();
    renderScreenNote();
    renderScreens();
  };
}

$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify({ setup: state.setup, projection: proj.doc, show: state.show }, null, 2)], { type: 'application/json' });
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
    if (doc.projection) proj.doc = doc.projection;
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

// The floor plan of the room: one depth frame of the hub (through the output: a phone cannot reach the
// hub), every point put on the floor (orthographic, from straight above) into cells of 5 cm. A cell is
// drawn when something stands there between 15 cm and 2 m above the floor (walls, tables, other
// stations, people): a wall becomes a line, a table a block. The floor the sensor sees is shown
// faintly; the ceiling is left out.
const PLAN_CELL = 0.05; // m
const OBSTACLE = [0.15, 2.0]; // m above the floor
async function loadRoomShot() {
  const o = out();
  $('planNote').textContent = 'lade Grundriss …';
  try {
    const r = await fetch('/api/points', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
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
    proj?.render();
    $('planNote').textContent = `Grundriss von ${new Date().toLocaleTimeString()} (${roomShot.source})`;
  } catch (e) {
    $('planNote').textContent = `Grundriss ging nicht: ${e.message}`;
  }
  drawPlan();
}
$('shotBtn').onclick = loadRoomShot;

/** the floor plan at the transform `v` (cached per view): cells colored by how high things stand there */
const shotCache = new WeakMap(); // view -> { key, canvas }
function shotLayer(cssW, cssH, dpr, v = view) {
  if (!roomShot) return null;
  const key = `${cssW}x${cssH}@${dpr}:${v.ox.toFixed(2)},${v.oy.toFixed(2)},${v.scale.toFixed(3)}:${roomShot.at}`;
  let cache = shotCache.get(v);
  if (cache?.key === key) return cache.canvas;
  cache ??= { key: '', canvas: document.createElement('canvas') };
  cache.key = key;
  shotCache.set(v, cache);
  const shotCanvas = cache.canvas;
  shotCanvas.width = Math.round(cssW * dpr);
  shotCanvas.height = Math.round(cssH * dpr);
  const g = shotCanvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  const { x0, z0, nx, nz, hits, top, floor } = roomShot;
  const size = PLAN_CELL * v.scale + 0.5; // a hair larger: no seams between cells
  for (let cz = 0; cz < nz; cz++) {
    for (let cx = 0; cx < nx; cx++) {
      const c = cz * nx + cx;
      if (!hits[c] && !floor[c]) continue;
      const px = v.ox + (x0 + cx * PLAN_CELL) * v.scale;
      const py = v.oy + (z0 + cz * PLAN_CELL) * v.scale;
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
  const pd = proj?.doc.default ?? map.projection;
  map.setProjection(pd);
  const depth = Math.max(pd.zone.far, pd.field.far) + 0.5;
  const spanW = Math.max(s.size.w, 2 * ((depth - s.sensor.front) * map.tanH) + 1) + 1;
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
  // the sensor's view (gray) and the default projection's zone (lighter)
  const sx = s.size.w / 2 + s.sensor.x;
  const sz = s.sensor.front;
  const t = map.tanH;
  const [zl0, zr0] = coneAt(s, t, pd.zone.near);
  const [zl1, zr1] = coneAt(s, t, pd.zone.far);
  g.fillStyle = 'rgba(120,170,255,0.08)';
  g.beginPath();
  g.moveTo(X(zl0), Y(pd.zone.near));
  g.lineTo(X(zr0), Y(pd.zone.near));
  g.lineTo(X(zr1), Y(pd.zone.far));
  g.lineTo(X(zl1), Y(pd.zone.far));
  g.closePath();
  g.fill();
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
  // the default projection's play field (edited in the tab "Projektion")
  const F = pd.field;
  g.strokeStyle = 'rgba(255,220,120,0.6)';
  g.setLineDash([5, 4]);
  g.beginPath();
  g.moveTo(X(F.nearL), Y(F.near));
  g.lineTo(X(F.nearR), Y(F.near));
  g.lineTo(X(F.farR), Y(F.far));
  g.lineTo(X(F.farL), Y(F.far));
  g.closePath();
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,220,120,0.85)';
  g.textAlign = 'left';
  g.fillText('Spielfeld (Standard)', X(F.farR) + 6, Y(F.far) + 4);
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
  // the zone being drawn, with a line to the pointer
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

/** the block zone corner under the pointer (within 9 px, 16 px for touch): { id, i } or null */
function cornerAt(px, py, reach = 9) {
  for (const b of state.setup.blocks) {
    for (let i = 0; i < b.points.length; i++) {
      const [x, y] = toPx(b.points[i][0], b.points[i][1]);
      if (Math.hypot(x - px, y - py) <= reach) return { id: b.id, i };
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
  $('blockDone').hidden = false;
  $('planNote').textContent = 'Eckpunkte in die Draufsicht tippen · Doppelklick, Tippen auf den ersten Punkt oder „Fertig“ schließt · Esc bricht ab';
  drawPlan();
}

function stopDrawing(save) {
  const pts = edit.drawing;
  edit.drawing = null;
  edit.mouse = null;
  $('plan').classList.remove('drawing');
  $('blockBtn').textContent = 'Sperrzone zeichnen';
  $('blockDone').hidden = true;
  $('planNote').textContent = '';
  if (save && pts && pts.length >= 3) {
    const id = Math.random().toString(36).slice(2, 10);
    state.setup.blocks.push({ id, name: `Sperrzone ${state.setup.blocks.length + 1}`, enabled: true, points: pts });
    edit.selected = id;
    setupChanged();
  }
  renderBlocks();
  drawPlan();
}

$('blockBtn').onclick = () => (edit.drawing ? stopDrawing(false) : startDrawing());
$('blockDone').onclick = () => stopDrawing(true);

const planCanvas = $('plan');
const mouseOf = (e) => {
  const r = planCanvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
const roundPlan = (px, py) => toPlan(px, py).map((v) => Math.round(v * 100) / 100);

planCanvas.addEventListener('pointerdown', (e) => {
  const [px, py] = mouseOf(e);
  const reach = e.pointerType === 'touch' ? 16 : 9;
  if (edit.drawing) {
    const first = edit.drawing[0];
    if (first && edit.drawing.length >= 3) {
      const [fx, fy] = toPx(first[0], first[1]);
      if (Math.hypot(fx - px, fy - py) <= reach + 1) {
        stopDrawing(true);
        return;
      }
    }
    edit.drawing.push(roundPlan(px, py));
    drawPlan();
    return;
  }
  const hit = cornerAt(px, py, reach);
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
  setupChanged();
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
  if (!o) rows.push(['Ausgabe', link.open ? 'meldet sich gleich' : 'keine Verbindung']);
  else {
    rows.push(['Szene', `${o.title || '–'} (${o.scene ?? '–'})`]);
    rows.push(['Zustand', o.state]);
    rows.push(['Bildrate', `${o.fps} fps${o.native ? ` · Anzeige ${o.native.refreshHz} Hz · ${o.native.late} verspätete Bilder` : ''}`]);
    const k = o.kinect;
    rows.push(['Kinect', k ? (k.connected ? `${k.fps} fps (Hub ${k.hubFps ?? '–'}), Latenz ${k.latencyMs} ms, ${k.sensor ?? ''}` : `keine Verbindung zu ${k.hub}`) : '–']);
    if (o.problem) rows.push(['Problem', o.problem]);
    rows.push(['Personen', `${o.persons.length}${o.tracker ? ` · ${o.tracker}` : ''}`]);
    rows.push(['Boden', o.room.found ? `erkannt: Kinect ${o.room.height.toFixed(2)} m hoch${o.room.pitch != null ? `, Neigung ${o.room.pitch.toFixed(1)}°` : ''}` : `von Hand: ${o.room.height} m`]);
    rows.push(['LED-Bild', `${o.led[0]} × ${o.led[1]}`]);
    const sc = o.screen;
    if (sc) rows.push(['Bildschirm der Ausgabe', `${sc.name ? `${sc.name} · ` : ''}${sc.w}×${sc.h}${sc.left != null ? ` bei ${sc.left}, ${sc.top}` : ''} · Fenster ${sc.inner[0]}×${sc.inner[1]} · Skalierung ${Math.round(sc.dpr * 100)} %${sc.fullscreen ? ' · Vollbild' : ''}`]);
    rows.push(['Status der Szene', o.status || '–']);
  }
  if (state.server) {
    rows.push(['Daten', state.server.data]);
    rows.push(['Version', `${state.server.version} (Framework ${state.server.build})`]);
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

// ---------- remote controls (pairing) ----------

function renderPairing() {
  const p = state.pairing;
  const root = $('pairLinks');
  root.replaceChildren();
  $('pairCode').textContent = p?.code ?? '–';
  $('pairRenew').hidden = !state.local;
  $('pairLocalOnly').hidden = state.local;
  if (!p?.urls?.length) {
    el('div', 'muted', root, 'Die Ausgabe hat keine Adresse im Netz gefunden (nur dieser Computer: --control-bind 127.0.0.1, oder kein Netz).');
    return;
  }
  for (const url of p.urls) {
    const box = el('div', 'pair-box', root);
    const img = el('img', 'pair-qr', box);
    img.alt = 'QR-Code zum Koppeln';
    img.src = `/api/pair.svg?url=${encodeURIComponent(url)}`;
    const a = el('a', 'pair-url', box, url.replace(/\?k=.*$/, ''));
    a.href = url;
  }
}
$('pairRenew').onclick = () => {
  if (!confirm('Neuen Code erzeugen? Alle gekoppelten Geräte müssen danach neu koppeln.')) return;
  link.send('pairing.renew');
};

// ---------- start ----------

function loadSetup(raw) {
  state.setup = normalizeSetup(raw);
  map.setSetup(state.setup);
  if (setupGui) setupGui.refresh();
  else buildSetupGui();
  renderBlocks();
  renderSetupNote();
  renderScreenNote();
  drawPlan();
}

function loadShow(raw) {
  state.show = normalizeShow(raw);
  renderPlaylist();
  renderShowSettings();
  if (state.selected && !state.show.entries.some((e) => e.id === state.selected)) selectEntry(null);
}

// ---------- projections (tab "Projektion", projection.js) ----------

proj = createProjectionTab({
  link,
  state,
  out,
  toast,
  el,
  $,
  drawRoomShot(g, v, cssW, cssH, dpr) {
    const shot = shotLayer(cssW, cssH, dpr, v);
    if (shot) g.drawImage(shot, 0, 0, cssW, cssH);
  },
});

/** For tests. */
globalThis.__wallControl = { state, toPx, toPlan, edit, view, proj, link };

loadSetup(null);
loadShow(null);
renderLive();
