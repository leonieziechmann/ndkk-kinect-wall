// Scene parameters: a scene declares them, the runtime shows sliders/checkboxes (lil-gui) and keeps
// what the user changed in localStorage. Values the user did not touch follow the code, so a new
// default in main.js shows up right away.
//
//   params: {
//     size:  { value: 2, min: 0.5, max: 8, step: 0.1, label: 'Punktgröße', folder: 'Punkte' },
//     glow:  true,                                   // checkbox
//     tint:  '#ffffff',                              // color picker
//     mode:  { value: 'lines', options: ['lines', 'dots'] },
//   }

import GUI from 'lil-gui';

const COLOR_RE = /^#[0-9a-f]{6}$/i;

export function normalizeParams(defs) {
  const list = [];
  if (!defs || typeof defs !== 'object') return list;
  for (const [key, raw] of Object.entries(defs)) {
    const spec = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : { value: raw };
    const v = spec.value;
    let kind = null;
    if (spec.options !== undefined) kind = 'select';
    else if (typeof v === 'number' && Number.isFinite(v)) kind = 'number';
    else if (typeof v === 'boolean') kind = 'boolean';
    else if (typeof v === 'string' && COLOR_RE.test(v)) kind = 'color';
    else if (typeof v === 'string') kind = 'string';
    if (!kind) {
      console.warn(`Parameter "${key}": Wert ${JSON.stringify(v)} wird nicht unterstützt`);
      continue;
    }
    list.push({ ...spec, key, kind, label: spec.label ?? key });
  }
  return list;
}

export const optionValues = (options) => (Array.isArray(options) ? options : Object.values(options ?? {}));

export function acceptsParam(p, v) {
  switch (p.kind) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'color':
      return typeof v === 'string' && COLOR_RE.test(v);
    case 'select':
      return optionValues(p.options).includes(v);
    case 'string':
      return typeof v === 'string';
    default:
      return false;
  }
}

export const storeKey = (scene) => `kinect-scene:${scene}:params`;

export function readStore(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    if (Object.keys(value).length) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    // private mode or storage blocked: the values just are not remembered
  }
}

export class ParamPanel {
  constructor() {
    this.gui = null;
    this.visible = true;
  }

  /**
   * Values for a scene: the user's earlier changes over the defaults from the code. With
   * `overrides` (an object, e.g. a show entry of the LED wall) those instead of the stored ones.
   */
  resolve(scene, defs, overrides = null) {
    const list = normalizeParams(defs);
    const stored = overrides && typeof overrides === 'object' ? overrides : readStore(storeKey(scene));
    const values = {};
    for (const p of list) values[p.key] = acceptsParam(p, stored[p.key]) ? stored[p.key] : p.value;
    return { scene, list, values };
  }

  /** Shows the panel for resolved params. onChange(key, value) runs after every change. */
  mount({ scene, list, values }, onChange) {
    this.gui?.destroy();
    this.gui = null;
    if (!list.length) return;
    const key = storeKey(scene);
    const gui = new GUI({ title: 'Parameter', width: 300 });
    gui.domElement.classList.add('kinect-params');
    const folders = new Map();
    const controllers = [];
    for (const p of list) {
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
        const stored = readStore(key);
        if (v === p.value) delete stored[p.key];
        else stored[p.key] = v;
        writeStore(key, stored);
        mark();
        onChange?.(p.key, v);
      });
      controllers.push({ c, p, mark });
    }
    const actions = {
      reset: () => {
        writeStore(key, {});
        for (const { c, p, mark } of controllers) {
          if (values[p.key] === p.value) continue;
          values[p.key] = p.value;
          c.updateDisplay();
          mark();
          onChange?.(p.key, p.value);
        }
      },
      copy: () => navigator.clipboard?.writeText(JSON.stringify(values, null, 2)),
    };
    gui.add(actions, 'reset').name('Zurücksetzen');
    gui.add(actions, 'copy').name('Werte kopieren (JSON)');
    gui.show(this.visible);
    this.gui = gui;
  }

  setVisible(visible) {
    this.visible = visible;
    this.gui?.show(visible);
  }
}
