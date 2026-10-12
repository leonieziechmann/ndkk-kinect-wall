// show.js — the show of the LED wall: a playlist of scenes (each with its own param values), played
// by the output (wall-bevy, show.rs) and edited here. Kept by the output (show.json in its data folder).

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const TRANSITIONS = Object.freeze({ Überblenden: 'cross', 'über Schwarz': 'black', 'harter Schnitt': 'cut' });

/** Test images of the output (patterns.rs draws them). */
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
  return { id: newId(), scene, label, duration: 300, enabled: true, wait: true, params: {} };
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
      wait: e.wait !== false, // may run over its duration (show.waitForEmpty, waitForRound); false: on time (ads)
      params: e.params && typeof e.params === 'object' && !Array.isArray(e.params) ? { ...e.params } : {},
    });
  }
  const maxWait = num(raw?.maxWait, 0, 3600, 120);
  return {
    entries,
    auto: raw?.auto === true, // switch to the next entry after its duration
    waitForEmpty: raw?.waitForEmpty !== false, // ... but only when nobody is in front of the wall
    maxWait, // s: at most this much longer with one person in front (see crowdWait)
    maxWaitMany: num(raw?.maxWaitMany, 0, 3600, maxWait), // ... with manyPersons or more
    manyPersons: Math.round(num(raw?.manyPersons, 2, 50, 10)),
    waitForRound: raw?.waitForRound !== false, // a game (ctx.holdSwitch) switches between its rounds instead
    maxRoundWait: num(raw?.maxRoundWait, 0, 3600, 120), // s: at most this much longer
    transition: Object.values(TRANSITIONS).includes(raw?.transition) ? raw.transition : 'cross',
    fade: num(raw?.fade, 0, 10, 1.5), // s
  };
}
