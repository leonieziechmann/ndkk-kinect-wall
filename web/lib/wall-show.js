// wall-show.js — the show of the LED wall: a playlist of scenes (each with its own param values),
// played by the output window (/wall/, lib/wall-output.js) and edited in the control center
// (/control/, lib/control.js). Saved like the setup (lib/wall-bus.js: loadDoc('show')).

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const TRANSITIONS = Object.freeze({ Überblenden: 'cross', 'über Schwarz': 'black', 'harter Schnitt': 'cut' });

/** Test images of the output window (lib/wall-output.js draws them). */
export const PATTERNS = Object.freeze({
  grid: 'Raster (Kabinette, Ränder, Ecken)',
  people: 'Kalibrierung: Personen auf der Wand',
  bars: 'Farbbalken',
  ramp: 'Graustufen',
  sweep: 'Laufbalken',
  white: 'Weiß',
  red: 'Rot',
  green: 'Grün',
  blue: 'Blau',
});

export const newId = () => Math.random().toString(36).slice(2, 10);

const num = (v, min, max, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

export function newEntry(scene, label = '') {
  return { id: newId(), scene, label, duration: 300, enabled: true, params: {} };
}

/** A complete, valid show from anything. */
export function normalizeShow(raw) {
  const entries = [];
  const ids = new Set();
  for (const e of Array.isArray(raw?.entries) ? raw.entries : []) {
    if (!e || typeof e !== 'object' || !NAME_RE.test(e.scene ?? '')) continue;
    let id = typeof e.id === 'string' && /^[a-z0-9]{1,32}$/i.test(e.id) ? e.id : newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    entries.push({
      id,
      scene: e.scene,
      label: typeof e.label === 'string' ? e.label.slice(0, 120) : '',
      duration: num(e.duration, 5, 86400, 300),
      enabled: e.enabled !== false,
      params: e.params && typeof e.params === 'object' && !Array.isArray(e.params) ? { ...e.params } : {},
    });
  }
  return {
    entries,
    auto: raw?.auto === true, // switch to the next entry after its duration
    waitForEmpty: raw?.waitForEmpty !== false, // ... but only when nobody is in front of the wall
    maxWait: num(raw?.maxWait, 0, 3600, 120), // s: at most this much longer
    waitForRound: raw?.waitForRound !== false, // a game (ctx.holdSwitch) switches between its rounds instead
    maxRoundWait: num(raw?.maxRoundWait, 0, 3600, 120), // s: at most this much longer
    transition: Object.values(TRANSITIONS).includes(raw?.transition) ? raw.transition : 'cross',
    fade: num(raw?.fade, 0, 10, 1.5), // s
  };
}

/** The next enabled entry after `id` (dir +1) or before it (-1); null if there is none. */
export function stepEntry(show, id, dir = 1) {
  const list = show.entries;
  if (!list.length) return null;
  const at = list.findIndex((e) => e.id === id);
  for (let i = 1; i <= list.length; i++) {
    const e = list[(((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir * i) % list.length + list.length) % list.length];
    if (e.enabled) return e;
  }
  return null;
}
