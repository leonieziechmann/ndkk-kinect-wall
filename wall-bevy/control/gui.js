// gui.js — forms for params, the setup and the projections: folders of controls (number with a
// slider, switch, color, choice, text), the part of lil-gui's interface this page uses, made of
// plain inputs (they work with touch, on a phone too).
//
//   const gui = new GUI({ container, title });
//   gui.add(obj, 'size', 0, 10, 0.1).name('Größe').onChange((v) => …);
//   gui.add(obj, 'mode', ['a', 'b']) · gui.add(obj, 'mode', { Label: 'a' }) · gui.addColor(obj, 'tint')

function el(tag, className, parent, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

/** Digits after the point that a step needs (0.05 -> 2). */
function decimals(step) {
  if (!Number.isFinite(step) || step <= 0 || step >= 1) return 0;
  return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
}

class Controller {
  constructor(gui, object, property) {
    this.object = object;
    this.property = property;
    this.domElement = el('div', 'lil-controller', gui.$children);
    this.$name = el('div', 'lil-name', this.domElement, property);
    this.$widget = el('div', 'lil-widget', this.domElement);
    this._onChange = null;
    this._onFinish = null;
  }

  name(text) {
    this.$name.textContent = text;
    return this;
  }

  onChange(fn) {
    this._onChange = fn;
    return this;
  }

  onFinishChange(fn) {
    this._onFinish = fn;
    return this;
  }

  show(on = true) {
    this.domElement.hidden = !on;
    return this;
  }

  hide() {
    return this.show(false);
  }

  getValue() {
    return this.object[this.property];
  }

  /** A new value from the input: kept, reported (and when the input is done: finished). */
  _set(v, finish) {
    this.object[this.property] = v;
    this._onChange?.(v);
    if (finish) this._onFinish?.(v);
  }

  updateDisplay() {
    return this;
  }
}

class NumberController extends Controller {
  constructor(gui, object, property, min, max, step) {
    super(gui, object, property);
    this.min = Number.isFinite(min) ? min : null;
    this.max = Number.isFinite(max) ? max : null;
    this.step = Number.isFinite(step) && step > 0 ? step : this.min !== null && this.max !== null ? (this.max - this.min) / 100 : 0.01;
    this.digits = decimals(this.step);
    if (this.min !== null && this.max !== null) {
      this.$range = el('input', 'lil-range', this.$widget);
      this.$range.type = 'range';
      this.$range.min = String(this.min);
      this.$range.max = String(this.max);
      this.$range.step = String(this.step);
      this.$range.oninput = () => {
        const v = this._clamp(Number(this.$range.value));
        this.$num.value = this._text(v);
        this._set(v, false);
      };
      this.$range.onchange = () => this._onFinish?.(this.getValue());
    }
    this.$num = el('input', 'lil-number', this.$widget);
    this.$num.type = 'number';
    this.$num.step = String(this.step);
    this.$num.inputMode = 'decimal';
    this.$num.onchange = () => {
      const raw = Number(String(this.$num.value).replace(',', '.'));
      if (!Number.isFinite(raw)) return this.updateDisplay();
      const v = this._clamp(raw);
      this._set(v, true);
      this.updateDisplay();
    };
    this.updateDisplay();
  }

  _clamp(v) {
    let x = v;
    if (this.min !== null) x = Math.max(this.min, x);
    if (this.max !== null) x = Math.min(this.max, x);
    return Number(x.toFixed(this.digits));
  }

  _text(v) {
    return Number.isFinite(v) ? String(Number(v.toFixed(this.digits))) : '';
  }

  updateDisplay() {
    const v = this.getValue();
    if (document.activeElement !== this.$num) this.$num.value = this._text(v);
    if (this.$range) this.$range.value = String(v);
    return this;
  }
}

class BooleanController extends Controller {
  constructor(gui, object, property) {
    super(gui, object, property);
    this.domElement.classList.add('lil-bool');
    this.$box = el('input', '', this.$widget);
    this.$box.type = 'checkbox';
    this.$box.onchange = () => this._set(this.$box.checked, true);
    this.updateDisplay();
  }

  updateDisplay() {
    this.$box.checked = !!this.getValue();
    return this;
  }
}

class SelectController extends Controller {
  constructor(gui, object, property, options) {
    super(gui, object, property);
    // [value, ...] (label = value) or { label: value }
    this.options = Array.isArray(options) ? options.map((v) => [String(v), v]) : Object.entries(options);
    this.$select = el('select', '', this.$widget);
    this.options.forEach(([label], i) => {
      el('option', '', this.$select, label).value = String(i);
    });
    this.$select.onchange = () => {
      const o = this.options[Number(this.$select.value)];
      if (o) this._set(o[1], true);
    };
    this.updateDisplay();
  }

  updateDisplay() {
    const i = this.options.findIndex(([, v]) => v === this.getValue());
    this.$select.value = String(Math.max(0, i));
    return this;
  }
}

class ColorController extends Controller {
  constructor(gui, object, property) {
    super(gui, object, property);
    this.$color = el('input', '', this.$widget);
    this.$color.type = 'color';
    this.$color.oninput = () => this._set(this.$color.value, false);
    this.$color.onchange = () => this._onFinish?.(this.$color.value);
    this.updateDisplay();
  }

  updateDisplay() {
    this.$color.value = String(this.getValue() ?? '#000000');
    return this;
  }
}

class TextController extends Controller {
  constructor(gui, object, property) {
    super(gui, object, property);
    this.$text = el('input', '', this.$widget);
    this.$text.type = 'text';
    this.$text.onchange = () => this._set(this.$text.value, true);
    this.updateDisplay();
  }

  updateDisplay() {
    if (document.activeElement !== this.$text) this.$text.value = String(this.getValue() ?? '');
    return this;
  }
}

export default class GUI {
  constructor({ container = null, title = '', parent = null } = {}) {
    this.parent = parent;
    this.domElement = el('div', parent ? 'lil-gui lil-folder' : 'lil-gui lil-root');
    this.$title = el('button', 'lil-title', this.domElement, title);
    this.$title.type = 'button';
    this.$title.onclick = () => this.domElement.classList.toggle('lil-closed');
    this.$children = el('div', 'lil-children', this.domElement);
    this.controllers = [];
    this.folders = [];
    container?.append(this.domElement);
  }

  add(object, property, a, b, c) {
    const v = object[property];
    let ctl;
    if (Array.isArray(a) || (a !== null && typeof a === 'object')) ctl = new SelectController(this, object, property, a);
    else if (typeof v === 'number') ctl = new NumberController(this, object, property, a, b, c);
    else if (typeof v === 'boolean') ctl = new BooleanController(this, object, property);
    else ctl = new TextController(this, object, property);
    this.controllers.push(ctl);
    return ctl;
  }

  addColor(object, property) {
    const ctl = new ColorController(this, object, property);
    this.controllers.push(ctl);
    return ctl;
  }

  addFolder(title) {
    const f = new GUI({ title, parent: this });
    this.$children.append(f.domElement);
    this.folders.push(f);
    return f;
  }

  open(on = true) {
    this.domElement.classList.toggle('lil-closed', !on);
    return this;
  }

  close() {
    return this.open(false);
  }

  destroy() {
    this.domElement.remove();
  }
}
