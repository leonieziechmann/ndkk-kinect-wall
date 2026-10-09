// control-projection.js — the tab "Projektion" of the control center (lib/control.js, see WALL.md):
// how people are mapped onto the wall, as the default for every scene and per scene.
//
//   top view     the play field on the floor (drag its corners, the zone, where it lands on the wall),
//                the view cone, the room's floor plan, the people live and where the wall shows them
//   front view   the wall: the target range, the height mapping (room height -> wall height), people
//   curves       one response curve per axis (across, height, depth): drag points, double click
//                adds or removes one, presets
//   form         every value (lil-gui); per scene only what differs from the default is stored
//   assistant    one person walks the play field's corners (and reaches up); the wall shows a small
//                floor plan meanwhile, so it works alone
//
// The projections live in projection.json (lib/wall-bus.js: loadDoc('projection')), shared by every
// worktree like the setup: { default: profile, scenes: { name: { key: value } } }.

import GUI from 'lil-gui';
import { saveDoc, loadDoc, debounce } from './wall-bus.js';
import {
  WallMap,
  PROJECTION_FIELDS,
  CURVE_PRESETS,
  LUT_N,
  normalizeProjectionDoc,
  normalizeCurve,
  resolveProjection,
  getPath,
  setPath,
  curveLut,
  evalLut,
  invertLut,
  coneAt,
  fieldFromCone,
} from './wall.js';

const STILL_S = 2; // the assistant takes a corner after standing still this long
const STILL_M = 0.12; // ... within this many meters
const MIN_STEP_M = 0.6; // ... at least this far from the corners caught so far
const CORNERS = [
  { key: 'nearL', title: 'Vorne links', text: 'Geh dorthin, wo das Spielfeld vorne links aufhört (nah an der Wand, linker Rand), und bleib 2 Sekunden still stehen.' },
  { key: 'nearR', title: 'Vorne rechts', text: 'Jetzt vorne rechts: nah an der Wand, rechter Rand. Wieder 2 Sekunden still stehen.' },
  { key: 'farR', title: 'Hinten rechts', text: 'Hinten rechts: so weit weg, wie noch gespielt werden soll, rechter Rand.' },
  { key: 'farL', title: 'Hinten links', text: 'Zum Schluss hinten links.' },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r2 = (v) => Math.round(v * 100) / 100;

export function createProjectionTab(env) {
  const { bus, state, out, toast, el, $, drawRoomShot } = env;
  const P = {
    raw: null, // projection.json as loaded or last saved
    doc: normalizeProjectionDoc(null, state.setup),
    selected: '', // '' = the default, else a scene
    sceneDefaults: new Map(), // scene -> the projection its main.js asks for (null: none)
    lastEdit: 0,
    source: 'none',
  };
  const map = new WallMap();
  let gui = null;
  let proxies = [];
  const planView = { ox: 0, oy: 0, scale: 50 };
  const frontView = { ox: 0, oy: 0, scale: 50 };
  let handles = []; // draggable things in the top view (set by drawPlan)
  let drag = null;
  let hover = null;

  // ---------- the document ----------

  const save = debounce(async () => {
    P.source = await saveDoc('projection', P.doc);
    renderNote();
  }, 400);

  /** the scene's own wishes from its main.js (`projection: {...}`) */
  const defaultsOf = (name) => P.sceneDefaults.get(name) ?? null;
  /** what a scene gets without its own values: the default plus its main.js wishes */
  const roomOf = () => ({ setup: state.setup, tanH: tanH() });
  const inherited = (name) => resolveProjection({ default: P.doc.default, scenes: {} }, name, defaultsOf(name), roomOf());
  /** the projection being edited */
  const effective = () => (P.selected ? resolveProjection(P.doc, P.selected, defaultsOf(P.selected), roomOf()) : P.doc.default);
  const overrides = () => (P.selected ? (P.doc.scenes[P.selected] ?? {}) : {});

  function tanH() {
    return out()?.tanH ?? 0.7085;
  }

  let sendTimer = 0;
  let sendPending = false;
  /** to every page at once (at most 20 times a second while dragging), and saved */
  function changed({ rerender = true } = {}) {
    P.doc = normalizeProjectionDoc(P.doc, state.setup);
    P.lastEdit = Date.now();
    if (!sendTimer) {
      bus.send('projection', { projection: P.doc });
      sendTimer = setTimeout(() => {
        sendTimer = 0;
        if (sendPending) {
          sendPending = false;
          bus.send('projection', { projection: P.doc });
        }
      }, 50);
    } else sendPending = true;
    save();
    if (rerender) render();
  }

  /** Sets values of the edited projection: { key: value }. Per scene only what differs is kept. */
  function setValues(values, opts) {
    if (!P.selected) {
      for (const [k, v] of Object.entries(values)) setPath(P.doc.default, k, v);
    } else {
      const base = inherited(P.selected);
      const o = { ...(P.doc.scenes[P.selected] ?? {}) };
      for (const [k, v] of Object.entries(values)) {
        if (same(getPath(base, k), v)) delete o[k];
        else o[k] = v;
      }
      if (Object.keys(o).length) P.doc.scenes[P.selected] = o;
      else delete P.doc.scenes[P.selected];
    }
    changed(opts);
  }

  async function load() {
    const r = await loadDoc('projection');
    P.raw = r.doc;
    P.source = r.doc ? r.source : 'none';
    P.doc = normalizeProjectionDoc(r.doc, state.setup);
    render();
  }

  // files changed by someone else, live changes of another control center
  bus.on('file', (d) => {
    if (d.kind === 'projection' && Date.now() - P.lastEdit > 3000) load();
  });
  bus.on('projection', (d) => {
    if (!d?.projection) return;
    P.doc = normalizeProjectionDoc(d.projection, state.setup);
    render();
  });

  // ---------- which projection ----------

  async function loadDefaults(name) {
    if (!name || P.sceneDefaults.has(name)) return;
    const info = state.scenes.find((s) => s.name === name);
    if (!info) {
      P.sceneDefaults.set(name, null);
      return;
    }
    try {
      // the scene module only declares itself on import; its setup() is not run here
      const mod = await import(/* @vite-ignore */ `/scenes/${name}/${info.entry ?? 'main.js'}`);
      P.sceneDefaults.set(name, (mod.default ?? mod).projection ?? null);
    } catch {
      P.sceneDefaults.set(name, null);
    }
  }

  async function select(name) {
    P.selected = name;
    await loadDefaults(name);
    buildGui();
    render();
  }

  function renderSelect() {
    const sel = $('projSel');
    const playing = out()?.scene;
    const names = [...new Set([...state.scenes.map((s) => s.name), ...Object.keys(P.doc.scenes)])];
    const opts = [['', 'Standard (alle Szenen ohne eigene Werte)']];
    for (const n of names) {
      const info = state.scenes.find((s) => s.name === n);
      const own = Object.keys(P.doc.scenes[n] ?? {}).length;
      opts.push([n, `${n === playing ? '● ' : ''}${info?.title ?? n}${own ? ` · ${own} eigene` : ''}${info ? '' : ' (anderer Worktree)'}`]);
    }
    const key = JSON.stringify(opts);
    if (sel.dataset.key !== key) {
      sel.dataset.key = key;
      sel.replaceChildren();
      for (const [v, label] of opts) el('option', '', sel, label).value = v;
    }
    sel.value = P.selected;
    $('projPlay').hidden = !P.selected || !state.scenes.some((s) => s.name === P.selected);
  }

  function renderNote() {
    const parts = [];
    if (!P.selected) parts.push('gilt für jede Szene ohne eigene Werte');
    else {
      const n = Object.keys(overrides()).length;
      parts.push(n ? `${n} eigene Wert${n === 1 ? '' : 'e'}, der Rest vom Standard` : 'noch alles vom Standard');
      if (defaultsOf(P.selected)) parts.push('mit Vorgaben aus der main.js der Szene');
      if (out()?.scene === P.selected) parts.push('läuft gerade: Änderungen sofort auf der Wand');
    }
    parts.push({ devserver: 'gespeichert für alle Worktrees (projection.json im Haupt-Checkout)', local: 'nur in diesem Browser gespeichert', none: 'noch nicht gespeichert: Standard aus dem alten Wand-Setup' }[P.source] ?? '');
    $('projNote').textContent = parts.filter(Boolean).join(' · ');
  }

  $('projSel').onchange = () => select($('projSel').value);
  $('projPlay').onclick = () => bus.send('play', { scene: P.selected }, 'output');
  $('projCalib').onclick = () => {
    const on = out()?.pattern !== 'people';
    bus.send('pattern', { name: on ? 'people' : null, over: true }, 'output');
  };
  $('projReset').onclick = () => {
    if (!P.selected) {
      if (!confirm('Standard-Projektion aus dem Wand-Setup neu ableiten (wie vor der Projektion)? Eigene Werte der Szenen bleiben.')) return;
      P.doc = normalizeProjectionDoc({ scenes: P.doc.scenes }, state.setup);
      changed();
      buildGui();
      return;
    }
    if (!confirm(`Alle eigenen Werte von „${P.selected}“ löschen (dann gilt der Standard)?`)) return;
    delete P.doc.scenes[P.selected];
    changed();
  };

  // ---------- form ----------

  function buildGui() {
    gui?.destroy();
    gui = new GUI({ container: $('projGui'), title: P.selected ? `Projektion: ${P.selected}` : 'Standard-Projektion' });
    gui.domElement.classList.add('kinect-params');
    gui.domElement.style.width = '100%';
    const folders = new Map();
    proxies = [];
    const p = effective();
    for (const f of PROJECTION_FIELDS) {
      if (f.kind === 'curve') continue;
      if (!folders.has(f.group)) folders.set(f.group, gui.addFolder(f.group));
      const folder = folders.get(f.group);
      const proxy = { v: getPath(p, f.key) };
      let c;
      if (f.kind === 'select') c = folder.add(proxy, 'v', f.options);
      else if (f.kind === 'boolean') c = folder.add(proxy, 'v');
      else c = folder.add(proxy, 'v', f.min, f.max, f.step);
      c.name(f.label);
      c.onChange((v) => setValues({ [f.key]: v }, { rerender: false }));
      c.onFinishChange(() => render());
      // per scene: a click on the name of an own value gives it back to the default
      c.domElement.querySelector('.lil-name, .name')?.addEventListener('click', () => {
        if (!P.selected || !(f.key in overrides())) return;
        setValues({ [f.key]: getPath(inherited(P.selected), f.key) });
      });
      proxies.push({ f, proxy, c });
    }
    folders.get('Kamerabild-Szenen')?.close();
    refreshGui();
  }

  function refreshGui() {
    if (!gui) return;
    const p = effective();
    const o = overrides();
    for (const { f, proxy, c } of proxies) {
      const v = getPath(p, f.key);
      if (!same(proxy.v, v)) {
        proxy.v = v;
        c.updateDisplay();
      }
      const own = f.key in o;
      c.domElement.classList.toggle('changed', own);
      c.domElement.title = own ? 'eigener Wert dieser Szene – Klick auf den Namen: zurück zum Standard' : '';
      let show = true;
      if (f.key === 'margin') show = p.edge !== 'free';
      if (f.key === 'body.height') show = p.body.fit === 'height';
      if (f.key === 'image.distance') show = true;
      c.show(show);
    }
  }

  // ---------- presets for the play field ----------

  function sensorX() {
    return state.setup.size.w / 2 + state.setup.sensor.x;
  }

  function setField(f) {
    const v = {};
    for (const [k, x] of Object.entries(f)) v[`field.${k}`] = r2(x);
    setValues(v);
  }

  for (const b of document.querySelectorAll('[data-field-preset]')) {
    b.onclick = () => {
      const p = effective();
      const F = p.field;
      const s = state.setup;
      const t = tanH();
      const mid = (F.near + F.far) / 2;
      switch (b.dataset.fieldPreset) {
        case 'cone':
          setField(fieldFromCone(s, t, F.near, F.far, 0.25));
          break;
        case 'box': {
          const [l, r] = coneAt(s, t, mid, 0.25);
          setField({ nearL: l, nearR: r, farL: l, farR: r });
          break;
        }
        case 'real':
          setField({ nearL: p.out.left, nearR: s.size.w - p.out.right, farL: p.out.left, farR: s.size.w - p.out.right });
          break;
        case 'center': {
          const c = sensorX();
          const hn = (F.nearR - F.nearL) / 2;
          const hf = (F.farR - F.farL) / 2;
          setField({ nearL: c - hn, nearR: c + hn, farL: c - hf, farR: c + hf });
          break;
        }
        default:
      }
    };
  }

  // ---------- top view ----------

  const planCanvas = $('projPlan');
  const toPx = (x, z) => [planView.ox + x * planView.scale, planView.oy + z * planView.scale];
  const toPlan = (px, py) => [(px - planView.ox) / planView.scale, (py - planView.oy) / planView.scale];

  /** the map with the projection being edited (cheap: the curve tables are 5 × 33 samples) */
  function syncMap() {
    map.setSetup(state.setup);
    map.setProjection(effective());
    map.tanH = tanH();
  }

  /**
   * The people as the telemetry has them. Where the wall shows them: from the output when it plays
   * the scene being edited (smoothing and look-ahead included), else mapped here.
   */
  function people() {
    const o = out();
    const p = effective();
    const asOnWall = !!P.selected && o?.scene === P.selected;
    return (o?.persons ?? []).map((q) => {
      let x = q.x;
      let norm = q.norm ?? [0, 0, 0];
      if (!asOnWall) {
        const raw = map.mapX(q.real, q.z);
        x = p.apply === 'person' ? map.edge(raw) : raw;
        const [l, r] = map.target;
        norm = [(x - l) / (r - l), q.norm?.[1] ?? 0, map.fieldZ(q.z)];
      }
      return { ...q, wx: x, norm };
    });
  }

  function drawPlan() {
    syncMap();
    const canvas = planCanvas;
    const cssW = canvas.clientWidth || 600;
    const s = state.setup;
    const p = effective();
    const F = p.field;
    const t = tanH();
    map.tanH = t;
    const depth = Math.max(p.zone.far, F.far, p.image.distance) + 0.7;
    const sx = sensorX();
    const reach = (depth - s.sensor.front) * t;
    const x0 = Math.min(0, sx - reach, F.nearL, F.farL) - 0.4;
    const x1 = Math.max(s.size.w, sx + reach, F.nearR, F.farR) + 0.4;
    const ppm = cssW / (x1 - x0);
    const cssH = Math.round(Math.min(620, (depth + 0.5) * ppm));
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    }
    planView.scale = Math.min(ppm, (cssH - 24) / depth);
    planView.ox = cssW / 2 - ((x0 + x1) / 2) * planView.scale;
    planView.oy = 18;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#101014';
    g.fillRect(0, 0, cssW, cssH);
    const X = (x) => planView.ox + x * planView.scale;
    const Y = (z) => planView.oy + z * planView.scale;
    drawRoomShot?.(g, planView, cssW, cssH, dpr);
    // 1 m grid
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    g.fillStyle = '#5a5a68';
    g.font = '11px system-ui, sans-serif';
    for (let x = Math.ceil(x0); x <= x1; x++) {
      g.beginPath();
      g.moveTo(X(x) + 0.5, Y(0));
      g.lineTo(X(x) + 0.5, cssH);
      g.stroke();
      g.fillText(`${x}`, X(x) + 3, cssH - 4);
    }
    for (let z = 1; Y(z) < cssH - 12; z++) {
      g.beginPath();
      g.moveTo(0, Y(z) + 0.5);
      g.lineTo(cssW, Y(z) + 0.5);
      g.stroke();
      g.fillText(`${z} m`, 4, Y(z) - 3);
    }
    // the view cone and the zone
    const sz = s.sensor.front;
    g.fillStyle = 'rgba(120,170,255,0.07)';
    const [zl0, zr0] = coneAt(s, t, p.zone.near);
    const [zl1, zr1] = coneAt(s, t, p.zone.far);
    g.beginPath();
    g.moveTo(X(zl0), Y(p.zone.near));
    g.lineTo(X(zr0), Y(p.zone.near));
    g.lineTo(X(zr1), Y(p.zone.far));
    g.lineTo(X(zl1), Y(p.zone.far));
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.setLineDash([2, 3]);
    g.beginPath();
    for (const side of [-1, 1]) {
      g.moveTo(X(sx), Y(sz));
      g.lineTo(X(sx + side * reach), Y(depth));
    }
    g.stroke();
    // zone ends and the camera image's reference distance
    g.strokeStyle = 'rgba(140,190,255,0.55)';
    g.setLineDash([6, 4]);
    for (const z of [p.zone.near, p.zone.far]) {
      const [l, r] = coneAt(s, t, z);
      g.beginPath();
      g.moveTo(X(l), Y(z));
      g.lineTo(X(r), Y(z));
      g.stroke();
    }
    g.strokeStyle = 'rgba(200,140,255,0.35)';
    g.setLineDash([1, 4]);
    g.beginPath();
    g.moveTo(X(x0), Y(p.image.distance));
    g.lineTo(X(x1), Y(p.image.distance));
    g.stroke();
    g.setLineDash([]);
    // the wall, the sensor, the target range on the wall
    const [tl, tr] = map.target;
    g.fillStyle = '#3d5778';
    g.fillRect(X(0), Y(0) - 5, s.size.w * planView.scale, 5);
    g.fillStyle = '#ffdc78';
    g.fillRect(X(tl), Y(0) - 5, (tr - tl) * planView.scale, 3);
    g.fillStyle = '#fff';
    g.fillRect(X(sx) - 6, Y(sz) - 3, 12, 6);
    // the play field: lines of equal place on the wall (quarters of the target range) and of equal depth
    const lutX = curveLut(p.curve.x);
    const invX = invertLut(lutX);
    const lutZ = curveLut(p.curve.z);
    const invZ = invertLut(lutZ);
    const at = (u, v) => {
      const z = F.near + (F.far - F.near) * v;
      const l = F.nearL + (F.farL - F.nearL) * v;
      const r = F.nearR + (F.farR - F.nearR) * v;
      return [l + (p.mirror ? u : 1 - u) * (r - l), z];
    };
    g.strokeStyle = 'rgba(255,220,120,0.28)';
    for (let q = 1; q < 4; q++) {
      const u = evalLut(invX, q / 4);
      g.beginPath();
      g.moveTo(...toPx(...at(u, 0)));
      g.lineTo(...toPx(...at(u, 1)));
      g.stroke();
      const v = evalLut(invZ, q / 4);
      g.beginPath();
      g.moveTo(...toPx(...at(0, v)));
      g.lineTo(...toPx(...at(1, v)));
      g.stroke();
    }
    g.fillStyle = 'rgba(255,220,120,0.08)';
    g.strokeStyle = 'rgba(255,220,120,0.95)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(F.nearL), Y(F.near));
    g.lineTo(X(F.nearR), Y(F.near));
    g.lineTo(X(F.farR), Y(F.far));
    g.lineTo(X(F.farL), Y(F.far));
    g.closePath();
    g.fill();
    g.stroke();
    // where the field's edges land on the wall
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,220,120,0.45)';
    g.setLineDash([4, 4]);
    for (const [cx, cz] of [[F.nearL, F.near], [F.farL, F.far], [F.nearR, F.near], [F.farR, F.far]]) {
      g.beginPath();
      g.moveTo(X(cx), Y(cz));
      g.lineTo(X(map.mapX(cx, cz)), Y(0));
      g.stroke();
    }
    g.setLineDash([]);
    // handles
    handles = [
      { kind: 'corner', key: 'nearL', x: F.nearL, z: F.near },
      { kind: 'corner', key: 'nearR', x: F.nearR, z: F.near },
      { kind: 'corner', key: 'farL', x: F.farL, z: F.far },
      { kind: 'corner', key: 'farR', x: F.farR, z: F.far },
      { kind: 'zone', key: 'near', x: sx, z: p.zone.near },
      { kind: 'zone', key: 'far', x: sx, z: p.zone.far },
      { kind: 'out', key: 'left', x: tl, z: 0 },
      { kind: 'out', key: 'right', x: tr, z: 0 },
    ];
    for (const h of handles) {
      const [hx, hy] = toPx(h.x, h.z);
      const hot = hover === h.kind + h.key || drag?.kind + drag?.key === h.kind + h.key;
      g.fillStyle = h.kind === 'zone' ? '#8cbcff' : '#ffdc78';
      const r = hot ? 6 : 4.5;
      if (h.kind === 'zone') g.fillRect(hx - r * 1.6, hy - 2, r * 3.2, 4);
      else if (h.kind === 'out') {
        g.beginPath();
        g.moveTo(hx, hy + 1);
        g.lineTo(hx - r, hy + r * 1.8);
        g.lineTo(hx + r, hy + r * 1.8);
        g.fill();
      } else {
        g.fillRect(hx - r, hy - r, 2 * r, 2 * r);
        if (hot) {
          g.strokeStyle = '#fff';
          g.strokeRect(hx - r - 1.5, hy - r - 1.5, 2 * r + 3, 2 * r + 3);
        }
      }
    }
    g.fillStyle = '#ffdc78';
    g.font = '12px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText(`Spielfeld ${r2(F.near)}–${r2(F.far)} m`, X(F.farR) + 8, Y(F.far) - 4);
    // the people: where they stand -> where the wall shows them
    for (const q of people()) {
      const [px, py] = toPx(q.real, q.z);
      g.globalAlpha = q.inZone ? 1 : 0.4;
      g.strokeStyle = q.css ?? '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(X(q.wx), Y(0));
      g.stroke();
      g.fillStyle = q.css ?? '#fff';
      g.beginPath();
      g.arc(px, py, 7, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(`${q.norm[0].toFixed(2)} · ${q.norm[2].toFixed(2)}`, px + 10, py + 4);
      g.globalAlpha = 1;
    }
    wizardPlan(g);
    g.lineWidth = 1;
    renderStats(p);
  }

  function renderStats(p) {
    const F = p.field;
    const s = state.setup;
    const [tl, tr] = map.target;
    const gainAt = (v) => map.gain((F.nearL + F.nearR + (F.farL + F.farR - F.nearL - F.nearR) * v) / 2, F.near + (F.far - F.near) * v);
    const widthAt = (v) => F.nearR - F.nearL + (F.farR - F.farL - F.nearR + F.nearL) * v;
    const t = tanH();
    const view = (z) => 2 * Math.max(0, (z - s.sensor.front) * t);
    const tight = [0, 1].filter((v) => widthAt(v) > view(F.near + (F.far - F.near) * v) + 0.05);
    $('projStats').textContent = [
      `quer: ×${gainAt(0).toFixed(1)} vorne · ×${gainAt(0.5).toFixed(1)} Mitte · ×${gainAt(1).toFixed(1)} hinten (Wand-m pro Schritt)`,
      `Laufweg für ${r2(tr - tl)} m Wand: ${r2(widthAt(0))} m vorne, ${r2(widthAt(1))} m hinten`,
      tight.length ? `Achtung: ${tight.map((v) => (v ? 'hinten' : 'vorne')).join(' und ')} breiter als das Sichtfeld – die Ränder erreicht dort niemand` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  // dragging in the top view
  const mouseOf = (e, c) => {
    const r = c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  function handleAt(px, py) {
    let best = null;
    let bd = 11;
    for (const h of handles) {
      const [hx, hy] = toPx(h.x, h.z);
      const d = Math.hypot(hx - px, hy - py);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }
  planCanvas.addEventListener('pointerdown', (e) => {
    const h = handleAt(...mouseOf(e, planCanvas));
    if (!h) return;
    drag = { kind: h.kind, key: h.key };
    planCanvas.setPointerCapture(e.pointerId);
  });
  planCanvas.addEventListener('pointermove', (e) => {
    const [px, py] = mouseOf(e, planCanvas);
    if (!drag) {
      const h = handleAt(px, py);
      const key = h ? h.kind + h.key : null;
      if (key !== hover) {
        hover = key;
        planCanvas.style.cursor = h ? (h.kind === 'zone' ? 'ns-resize' : h.kind === 'out' ? 'ew-resize' : 'move') : '';
        drawPlan();
      }
      return;
    }
    const [x, z] = toPlan(px, py).map(r2);
    const p = effective();
    const F = p.field;
    const s = state.setup;
    const v = {};
    if (drag.kind === 'corner') {
      const front = drag.key.startsWith('near');
      const left = drag.key.endsWith('L');
      const depthKey = front ? 'field.near' : 'field.far';
      v[depthKey] = front ? Math.min(z, F.far - 0.2) : Math.max(z, F.near + 0.2);
      v[`field.${drag.key}`] = x;
      if ($('projSym').checked) {
        const other = `field.${front ? 'near' : 'far'}${left ? 'R' : 'L'}`;
        v[other] = r2(2 * sensorX() - x);
      }
    } else if (drag.kind === 'zone') {
      v[`zone.${drag.key}`] = drag.key === 'near' ? Math.min(z, p.zone.far - 0.2) : Math.max(z, p.zone.near + 0.2);
    } else if (drag.kind === 'out') {
      if (drag.key === 'left') v['out.left'] = x;
      else v['out.right'] = r2(s.size.w - x);
      if ($('projSym').checked) v[drag.key === 'left' ? 'out.right' : 'out.left'] = drag.key === 'left' ? x : r2(s.size.w - x);
    }
    setValues(v, { rerender: false });
    drawPlan();
    drawFront();
  });
  planCanvas.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    render();
  });

  // ---------- front view ----------

  function drawFront() {
    const canvas = $('projFront');
    const cssW = canvas.clientWidth || 600;
    const s = state.setup;
    const p = effective();
    const top = Math.max(s.bottom + s.size.h, p.out.top, p.field.high) + 0.25;
    const bottom = Math.min(0, p.out.bottom);
    const left = 1.1; // m of room scale on the left
    const ppm = cssW / (s.size.w + left + 0.3);
    const cssH = Math.round((top - bottom + 0.3) * ppm);
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    }
    frontView.scale = ppm;
    frontView.ox = left * ppm;
    frontView.oy = top * ppm;
    const X = (x) => frontView.ox + x * ppm;
    const Y = (y) => frontView.oy - y * ppm;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#101014';
    g.fillRect(0, 0, cssW, cssH);
    // floor and the LEDs
    g.fillStyle = '#26262d';
    g.fillRect(0, Y(0), cssW, 2);
    g.fillStyle = '#0b1220';
    g.fillRect(X(0), Y(s.bottom + s.size.h), s.size.w * ppm, s.size.h * ppm);
    g.strokeStyle = '#3d5778';
    g.strokeRect(X(0) + 0.5, Y(s.bottom + s.size.h) + 0.5, s.size.w * ppm - 1, s.size.h * ppm - 1);
    // the target range and the height range
    const [tl, tr] = map.target;
    g.fillStyle = 'rgba(255,220,120,0.08)';
    g.fillRect(X(tl), Y(p.out.top), (tr - tl) * ppm, (p.out.top - p.out.bottom) * ppm);
    g.strokeStyle = 'rgba(255,220,120,0.7)';
    g.setLineDash([4, 4]);
    g.strokeRect(X(tl) + 0.5, Y(p.out.top) + 0.5, (tr - tl) * ppm - 1, (p.out.top - p.out.bottom) * ppm - 1);
    g.setLineDash([]);
    // room height -> wall height (the height curve): a scale on the left
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'right';
    const sx = X(-0.75);
    g.strokeStyle = '#555';
    g.beginPath();
    g.moveTo(sx, Y(p.field.low));
    g.lineTo(sx, Y(p.field.high));
    g.stroke();
    for (let y = Math.ceil(p.field.low * 4) / 4; y <= p.field.high + 1e-6; y += 0.25) {
      const wy = map.mapY(y);
      const major = Math.abs(y - Math.round(y * 2) / 2) < 1e-6;
      g.strokeStyle = major ? 'rgba(255,220,120,0.55)' : 'rgba(255,220,120,0.2)';
      g.beginPath();
      g.moveTo(sx, Y(y));
      g.lineTo(X(0), Y(wy));
      g.stroke();
      if (major) {
        g.fillStyle = '#9a9aa4';
        g.fillText(`${y.toFixed(1)} m`, sx - 4, Y(y) + 4);
      }
    }
    g.textAlign = 'left';
    g.fillStyle = '#9a9aa4';
    g.fillText('Raum', 2, 12);
    // the people: a bar from the feet to the head where the wall shows them
    const P2 = people();
    for (const q of P2) {
      const k = p.body.scale * (p.body.fit === 'height' && q.height ? Math.min(1.8, Math.max(0.55, p.body.height / q.height)) : 1);
      const h = q.height ?? (q.top ? q.top - (q.feet ?? 0) : 1.7);
      const x = q.wx;
      const y0 = map.mapY(0);
      const y1 = map.mapY(h * (p.apply === 'person' ? k : 1));
      const w = 0.45 * (p.apply === 'person' ? k : q.gain ?? 1);
      g.globalAlpha = q.inZone ? 0.9 : 0.35;
      g.fillStyle = q.css ?? '#fff';
      g.fillRect(X(x - w / 2), Y(y1), w * ppm, (y1 - y0) * ppm);
      if (q.reach != null) {
        const ry = map.mapY(q.reach * (p.apply === 'person' ? k : 1));
        g.fillRect(X(x) - 6, Y(ry) - 1, 12, 2);
      }
      g.globalAlpha = 1;
    }
  }

  // ---------- curves ----------

  const AXES = [
    { key: 'curve.x', canvas: 'curveX', sel: 'curveXSel', label: 'quer: Spielfeld → Wand' },
    { key: 'curve.y', canvas: 'curveY', sel: 'curveYSel', label: 'Höhe: Raum → Wand' },
    { key: 'curve.z', canvas: 'curveZ', sel: 'curveZSel', label: 'Tiefe: vorne → hinten' },
  ];
  const curveDrag = { axis: null, i: -1 };

  function curveBox(c) {
    const w = c.clientWidth || 200;
    const h = c.clientHeight || 150;
    const pad = 12;
    return { w, h, pad, X: (x) => pad + x * (w - 2 * pad), Y: (y) => h - pad - y * (h - 2 * pad), ix: (px) => (px - pad) / (w - 2 * pad), iy: (py) => (h - pad - py) / (h - 2 * pad) };
  }

  function curveMarkers(axis) {
    const p = effective();
    const res = [];
    for (const q of people()) {
      if (axis === 'curve.x') res.push({ t: map.fieldU(q.real, q.z), css: q.css });
      if (axis === 'curve.z') res.push({ t: (q.z - p.field.near) / (p.field.far - p.field.near), css: q.css });
      if (axis === 'curve.y' && q.reach != null) res.push({ t: (q.reach - p.field.low) / (p.field.high - p.field.low), css: q.css });
    }
    return res;
  }

  function drawCurve(a) {
    syncMap();
    const c = $(a.canvas);
    const dpr = devicePixelRatio || 1;
    const b = curveBox(c);
    if (c.width !== Math.round(b.w * dpr) || c.height !== Math.round(b.h * dpr)) {
      c.width = Math.round(b.w * dpr);
      c.height = Math.round(b.h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#15151a';
    g.fillRect(0, 0, b.w, b.h);
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let q = 0; q <= 4; q++) {
      g.beginPath();
      g.moveTo(b.X(q / 4), b.Y(0));
      g.lineTo(b.X(q / 4), b.Y(1));
      g.moveTo(b.X(0), b.Y(q / 4));
      g.lineTo(b.X(1), b.Y(q / 4));
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(b.X(0), b.Y(0));
    g.lineTo(b.X(1), b.Y(1));
    g.stroke();
    g.setLineDash([]);
    const pts = getPath(effective(), a.key);
    const lut = curveLut(pts, new Float32Array(LUT_N));
    g.strokeStyle = '#ffdc78';
    g.lineWidth = 2;
    g.beginPath();
    for (let k = 0; k <= 64; k++) {
      const t = k / 64;
      const y = evalLut(lut, t);
      if (k) g.lineTo(b.X(t), b.Y(y));
      else g.moveTo(b.X(t), b.Y(y));
    }
    g.stroke();
    g.lineWidth = 1;
    for (const m of curveMarkers(a.key)) {
      if (!(m.t > -0.2 && m.t < 1.2)) continue;
      const t = Math.min(1, Math.max(0, m.t));
      g.fillStyle = m.css ?? '#fff';
      g.beginPath();
      g.arc(b.X(t), b.Y(evalLut(lut, t)), 4, 0, Math.PI * 2);
      g.fill();
    }
    pts.forEach(([x, y], i) => {
      const hot = curveDrag.axis === a.key && curveDrag.i === i;
      g.fillStyle = hot ? '#fff' : '#ffdc78';
      g.fillRect(b.X(x) - 4, b.Y(y) - 4, 8, 8);
    });
    g.fillStyle = '#9a9aa4';
    g.font = '11px system-ui, sans-serif';
    g.fillText(a.label, 6, 13);
    const own = P.selected && a.key in overrides();
    $(a.sel).classList.toggle('changed', !!own);
  }

  function pointAt(a, px, py) {
    const b = curveBox($(a.canvas));
    const pts = getPath(effective(), a.key);
    return pts.findIndex(([x, y]) => Math.hypot(b.X(x) - px, b.Y(y) - py) <= 8);
  }

  for (const a of AXES) {
    const c = $(a.canvas);
    const sel = $(a.sel);
    el('option', '', sel, 'Vorlage …').value = '';
    for (const [k, v] of Object.entries(CURVE_PRESETS)) el('option', '', sel, v.label).value = k;
    el('option', '', sel, '↺ wie im Standard').value = 'inherit';
    sel.onchange = () => {
      const k = sel.value;
      sel.value = '';
      if (!k) return;
      if (k === 'inherit') {
        if (P.selected) setValues({ [a.key]: getPath(inherited(P.selected), a.key) });
        return;
      }
      setValues({ [a.key]: CURVE_PRESETS[k].points.map((q) => [...q]) });
    };
    c.addEventListener('pointerdown', (e) => {
      const [px, py] = mouseOf(e, c);
      const i = pointAt(a, px, py);
      if (i < 0) return;
      curveDrag.axis = a.key;
      curveDrag.i = i;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (curveDrag.axis !== a.key) {
        c.style.cursor = pointAt(a, ...mouseOf(e, c)) >= 0 ? 'move' : 'crosshair';
        return;
      }
      const b = curveBox(c);
      const [px, py] = mouseOf(e, c);
      const pts = getPath(effective(), a.key).map((q) => [...q]);
      const i = curveDrag.i;
      const lo = i > 0 ? pts[i - 1][0] + 0.03 : 0.02;
      const hi = i < pts.length - 1 ? pts[i + 1][0] - 0.03 : 0.98;
      pts[i] = [r2(Math.min(hi, Math.max(lo, b.ix(px)))), r2(Math.min(1, Math.max(0, b.iy(py))))];
      // keep it monotone: neighbors give way
      for (let j = i + 1; j < pts.length; j++) pts[j][1] = Math.max(pts[j][1], pts[j - 1][1]);
      for (let j = i - 1; j >= 0; j--) pts[j][1] = Math.min(pts[j][1], pts[j + 1][1]);
      setValues({ [a.key]: pts }, { rerender: false });
      drawCurve(a);
      drawPlan();
      drawFront();
    });
    c.addEventListener('pointerup', () => {
      if (curveDrag.axis !== a.key) return;
      curveDrag.axis = null;
      curveDrag.i = -1;
      render();
    });
    c.addEventListener('dblclick', (e) => {
      const [px, py] = mouseOf(e, c);
      const pts = getPath(effective(), a.key).map((q) => [...q]);
      const i = pointAt(a, px, py);
      if (i >= 0) pts.splice(i, 1);
      else {
        const b = curveBox(c);
        if (pts.length >= 5) return toast('Höchstens 5 Punkte pro Kurve', true);
        pts.push([r2(b.ix(px)), r2(b.iy(py))]);
      }
      setValues({ [a.key]: normalizeCurve(pts) });
    });
  }

  // ---------- the assistant ----------

  const W = {
    on: false,
    step: 0, // 0 intro, 1..4 corners, 5 reach, 6 result
    corners: [null, null, null, null], // [x, z] per CORNERS entry
    reach: null,
    standing: null,
    track: new Map(), // person id -> [[t, x, z, reach, height], ...]
    progress: 0,
    person: null,
    status: '',
    ok: false,
    capturedAt: 0,
  };

  function wizardHint(i) {
    const s = state.setup;
    const p = effective();
    const t = tanH();
    const near = Math.max(p.zone.near + 0.3, s.sensor.front + 0.9);
    const far = Math.max(near + 1, Math.min(p.zone.far - 0.3, s.sensor.front + 4));
    const z = i === 0 || i === 1 ? near : far;
    const [l, r] = coneAt(s, t, z, 0.35);
    return [i === 0 || i === 3 ? l : r, z];
  }

  function wizardSend() {
    const step = W.step;
    const c = CORNERS[step - 1];
    const title = step === 0 ? 'Spielfeld abschreiten' : c ? `${step}/5 · ${c.title}` : step === 5 ? '5/5 · Arme hoch' : 'Fertig';
    const text = step === 0
      ? 'Eine Person läuft gleich die vier Ecken des Spielfelds ab. Alle anderen bitte aus dem Bild.'
      : c ? c.text : step === 5 ? 'Streck beide Arme so hoch, wie Spieler oben reichen sollen, und halte sie 2 Sekunden.' : 'Das Spielfeld ist vermessen. Am Laptop übernehmen.';
    bus.send('wizard', {
      on: W.on,
      title,
      text,
      status: W.status,
      ok: W.ok,
      corners: W.corners,
      hint: c ? wizardHint(step - 1) : null,
      person: W.person,
      progress: W.progress,
      far: Math.max(effective().zone.far, ...W.corners.filter(Boolean).map((q) => q[1])),
    }, 'output');
    $('wizTitle').textContent = title;
    $('wizText').textContent = text;
    $('wizStatus').textContent = W.status;
    $('wizStatus').className = W.ok ? 'ok-text' : 'muted';
    $('wizBar').style.width = `${Math.round(Math.min(1, W.progress) * 100)}%`;
    $('wizBack').disabled = step <= 1;
    $('wizSkip').hidden = step !== 5;
    $('wizTake').hidden = !(step >= 1 && step <= 5);
    $('wizStart').hidden = step !== 0;
    $('wizResult').hidden = step !== 6;
    $('wizReachRow').hidden = W.reach == null;
    if (step === 6) renderWizardResult();
  }

  function wizardOpen() {
    W.on = true;
    W.step = 0;
    W.corners = [null, null, null, null];
    W.reach = null;
    W.standing = null;
    W.track.clear();
    W.status = out() ? '' : 'Keine Ausgabe verbunden: „Ausgabe öffnen“ oder die Live-Vorschau einschalten.';
    W.ok = false;
    W.progress = 0;
    $('wizBox').hidden = false;
    wizardSend();
  }

  function wizardClose() {
    W.on = false;
    $('wizBox').hidden = true;
    bus.send('wizard', { on: false }, 'output');
    drawPlan();
  }

  /** a step done: the next one after a moment (the person sees the check mark) */
  function wizardNext() {
    W.capturedAt = performance.now();
    W.track.clear();
    W.progress = 0;
    W.person = null;
    setTimeout(() => {
      if (!W.on) return;
      W.step = Math.min(6, W.step + 1);
      W.ok = false;
      W.status = '';
      wizardSend();
    }, 900);
  }

  function takeCorner(x, z) {
    W.corners[W.step - 1] = [r2(x), r2(z)];
    W.status = `✓ ${CORNERS[W.step - 1].title}: ${r2(x)} m vom linken Rand, ${r2(z)} m vor der Wand`;
    W.ok = true;
    wizardNext();
  }

  /** every telemetry: who stands still where (the one standing still longest is measured) */
  function wizardTick() {
    if (!W.on || W.step < 1 || W.step > 5 || performance.now() - W.capturedAt < 900) return;
    const o = out();
    const now = performance.now() / 1000;
    const list = o?.persons ?? [];
    for (const q of list) {
      const h = W.track.get(q.id) ?? [];
      h.push([now, q.real, q.z, q.reach, q.height]);
      while (h.length && now - h[0][0] > STILL_S + 0.6) h.shift();
      W.track.set(q.id, h);
    }
    for (const id of W.track.keys()) if (!list.some((q) => q.id === id)) W.track.delete(id);
    let best = null;
    for (const [id, h] of W.track) {
      // how long this person stood within STILL_M of where they stand now
      const [, x, z] = h.at(-1);
      let since = h.at(-1)[0];
      for (let i = h.length - 1; i >= 0; i--) {
        if (Math.hypot(h[i][1] - x, h[i][2] - z) > STILL_M) break;
        since = h[i][0];
      }
      const still = now - since;
      if (!best || still > best.still) best = { id, still, h, since };
    }
    W.ok = false;
    if (!list.length) {
      W.status = 'Niemand zu sehen – ins Bild der Kinect treten';
      W.progress = 0;
      W.person = null;
    } else if (best) {
      const pts = best.h.filter((r) => r[0] >= best.since);
      const x = pts.reduce((a, r) => a + r[1], 0) / pts.length;
      const z = pts.reduce((a, r) => a + r[2], 0) / pts.length;
      W.person = best.id;
      W.progress = best.still / STILL_S;
      if (W.step <= 4) {
        const tooClose = W.corners.some((c, i) => c && i !== W.step - 1 && Math.hypot(c[0] - x, c[1] - z) < MIN_STEP_M);
        W.status = tooClose ? 'Noch zu nah an einer anderen Ecke' : list.length > 1 ? `${list.length} Personen im Bild: gemessen wird, wer still steht` : `still stehen … ${r2(x)} / ${r2(z)} m`;
        if (tooClose) W.progress = 0;
        else if (best.still >= STILL_S) takeCorner(x, z);
      } else {
        const reach = Math.max(...pts.map((r) => r[3] ?? -1));
        const height = pts.map((r) => r[4]).filter((v) => v);
        W.status = reach > 0 ? `Hände bei ${r2(reach)} m` : 'keine Hände erkannt';
        if (reach <= 0) W.progress = 0;
        else if (best.still >= STILL_S) {
          W.reach = r2(reach);
          W.standing = height.length ? r2(height.sort((a, b) => a - b)[Math.floor(height.length / 2)]) : null;
          W.status = `✓ Reichweite ${W.reach} m${W.standing ? ` (Kopf ${W.standing} m)` : ''}`;
          W.ok = true;
          wizardNext();
        }
      }
    }
    wizardSend();
  }

  /** the trapezoid through the caught corners: the edges through left and right corners, at the mean front/back depth */
  function wizardField() {
    const [nl, nr, fr, fl] = W.corners;
    if (!nl || !nr || !fr || !fl) return null;
    let near = (nl[1] + nr[1]) / 2;
    let far = (fl[1] + fr[1]) / 2;
    let [a, b, c, d] = [nl, nr, fl, fr];
    if (far < near) {
      [near, far] = [far, near];
      [a, b, c, d] = [fl, fr, nl, nr];
    }
    const along = (p0, p1, z) => (Math.abs(p1[1] - p0[1]) < 0.05 ? (p0[0] + p1[0]) / 2 : p0[0] + ((p1[0] - p0[0]) * (z - p0[1])) / (p1[1] - p0[1]));
    let L0 = along(a, c, near);
    let R0 = along(b, d, near);
    let L1 = along(a, c, far);
    let R1 = along(b, d, far);
    if (L0 > R0) [L0, R0] = [R0, L0];
    if (L1 > R1) [L1, R1] = [R1, L1];
    return { near: r2(near), far: r2(far), nearL: r2(L0), nearR: r2(R0), farL: r2(L1), farR: r2(R1) };
  }

  function renderWizardResult() {
    const f = wizardField();
    $('wizFieldText').textContent = f ? `Spielfeld ${f.near}–${f.far} m vor der Wand, vorne ${r2(f.nearR - f.nearL)} m breit, hinten ${r2(f.farR - f.farL)} m` : 'Es fehlen Ecken.';
    $('wizTarget').textContent = P.selected ? `für „${P.selected}“` : 'als Standard für alle Szenen';
    $('wizApply').disabled = !f;
    drawPlan();
  }

  /** the caught corners on the top view (dashed: the field it would become) */
  function wizardPlan(g) {
    if (!W.on) return;
    const f = wizardField();
    if (f) {
      g.strokeStyle = '#7dffa8';
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(...toPx(f.nearL, f.near));
      g.lineTo(...toPx(f.nearR, f.near));
      g.lineTo(...toPx(f.farR, f.far));
      g.lineTo(...toPx(f.farL, f.far));
      g.closePath();
      g.stroke();
      g.setLineDash([]);
    }
    W.corners.forEach((c, i) => {
      if (!c) return;
      const [x, y] = toPx(c[0], c[1]);
      g.fillStyle = '#7dffa8';
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = '11px system-ui, sans-serif';
      g.fillText(CORNERS[i].title, x + 8, y - 6);
    });
    const step = W.step;
    if (step >= 1 && step <= 4) {
      const [hx, hz] = wizardHint(step - 1);
      const [x, y] = toPx(hx, hz);
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.arc(x, y, 14, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
  }

  $('projWizard').onclick = wizardOpen;
  $('wizClose').onclick = wizardClose;
  $('wizStart').onclick = () => {
    W.step = 1;
    W.status = '';
    W.capturedAt = performance.now();
    wizardSend();
  };
  $('wizBack').onclick = () => {
    if (W.step <= 1) return;
    W.step--;
    if (W.step <= 4) W.corners[W.step - 1] = null;
    W.track.clear();
    W.status = '';
    W.progress = 0;
    wizardSend();
  };
  $('wizSkip').onclick = () => {
    W.reach = null;
    W.step = 6;
    W.status = '';
    wizardSend();
  };
  $('wizTake').onclick = () => {
    // take where the measured person stands now (or the hint), without waiting
    const o = out();
    const q = o?.persons?.find((x) => x.id === W.person) ?? o?.persons?.[0];
    if (W.step <= 4) {
      if (!q) return toast('Niemand zu sehen', true);
      takeCorner(q.real, q.z);
    } else if (W.step === 5) {
      if (!q?.reach) return toast('Keine Hände erkannt', true);
      W.reach = r2(q.reach);
      W.standing = q.height ? r2(q.height) : null;
      W.ok = true;
      W.status = `✓ Reichweite ${W.reach} m`;
      wizardNext();
    }
    wizardSend();
  };
  $('wizAgain').onclick = wizardOpen;
  $('wizApply').onclick = () => {
    const f = wizardField();
    if (!f) return;
    const v = {};
    for (const [k, x] of Object.entries(f)) v[`field.${k}`] = x;
    if ($('wizZone').checked) {
      v['zone.near'] = r2(Math.max(0, f.near - 0.3));
      v['zone.far'] = r2(f.far + 0.4);
    }
    if ($('wizReach').checked && W.reach) {
      const s = state.setup;
      v['field.low'] = 0;
      v['field.high'] = W.reach;
      v['out.bottom'] = r2(s.bottom);
      v['out.top'] = r2(s.bottom + s.size.h);
    }
    setValues(v);
    toast(`Spielfeld übernommen ${P.selected ? `für ${P.selected}` : 'als Standard'}`);
    wizardClose();
  };

  // ---------- all of it ----------

  function render() {
    syncMap();
    renderSelect();
    renderNote();
    refreshGui();
    if ($('tab-projection').hidden) return;
    drawPlan();
    drawFront();
    for (const a of AXES) drawCurve(a);
  }

  addEventListener('resize', () => render());

  return {
    load,
    render,
    select,
    /** a telemetry arrived: live people, the assistant */
    tick() {
      wizardTick();
      if ($('tab-projection').hidden) return;
      renderSelect();
      drawPlan();
      drawFront();
      for (const a of AXES) drawCurve(a);
    },
    /** the setup changed (wall size, sensor): a default that was never saved follows it */
    setupChanged() {
      P.doc = normalizeProjectionDoc(P.source === 'none' ? { scenes: P.doc.scenes } : P.doc, state.setup);
      render();
    },
    get doc() {
      return P.doc;
    },
    set doc(d) {
      P.doc = normalizeProjectionDoc(d, state.setup);
      changed();
      buildGui();
    },
    get selected() {
      return P.selected;
    },
    /** for tests: the assistant's state */
    get wizard() {
      return W;
    },
    buildGui,
  };
}
