// wall-bus.js — messages between the control center (/control/), the output window (/wall/) and the
// wall scenes, plus loading and saving the wall setup, the projections and the show.
//
// Transport: the dev server relays every message to all pages it serves (Vite's HMR WebSocket,
// event 'kinect:wall', see tools/vite-plugin-kinect.js), so the output may run in another browser
// or a kiosk window of its own. A BroadcastChannel carries them too (same browser; also for a build
// served without Node). Messages that arrive twice are dropped.
//
//   const bus = new WallBus('control');
//   bus.on('telemetry', (data, msg) => …);
//   bus.send('play', { entry: 'abc' });
//
// Documents: setup (the LED wall, lib/wall.js), projection (the default and per scene, lib/wall.js)
// and show (the playlist, lib/wall-show.js). The dev server keeps them in files: setup and projection
// once for every worktree (main checkout: web/.cache/wall/setup.json, projection.json), the show per
// checkout (web/.cache/wall/show.json, its scenes differ).
// Without a dev server they live in localStorage.

const CHANNEL = 'kinect-wall';
const SEEN = 512;

export class WallBus {
  /** role: 'control' | 'output' | 'scene' (a message's `to` may name a role or a page id) */
  constructor(role) {
    this.role = role;
    this.id = `${role}-${Math.random().toString(36).slice(2, 10)}`;
    this.n = 0;
    this.handlers = new Map();
    this.seen = new Set();
    this.hot = import.meta.hot ?? null;
    this.hot?.on('kinect:wall', (m) => this._receive(m));
    this.hot?.on('kinect:wall-file', (m) => this._emit('file', m ?? {}, { type: 'file', from: 'devserver' }));
    try {
      this.bc = new BroadcastChannel(CHANNEL);
      this.bc.onmessage = (e) => this._receive(e.data);
    } catch {
      this.bc = null;
    }
    // tells the dev server's relay who this page is (it only forwards to pages it knows)
    try {
      this.hot?.send('kinect:wall', { id: `${this.id}:0`, from: this.id, role, type: 'hello', data: {}, t: Date.now() });
    } catch {
      // no dev server
    }
  }

  /** Sends to every other page (or only to `to`: a role or a page id). */
  send(type, data = {}, to = null) {
    const msg = { id: `${this.id}:${++this.n}`, from: this.id, role: this.role, to, type, data, t: Date.now() };
    try {
      this.hot?.send('kinect:wall', msg);
    } catch {
      // dev server gone: the BroadcastChannel still works within this browser
    }
    try {
      this.bc?.postMessage(msg);
    } catch {
      // data that cannot be cloned: the dev server relay carries it
    }
    return msg;
  }

  /** fn(data, msg) for messages of `type` ('*' = all); returns a function that unsubscribes. */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  close() {
    this.bc?.close();
    this.handlers.clear();
  }

  _receive(m) {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string' || m.from === this.id) return;
    if (m.to && m.to !== this.id && m.to !== this.role) return;
    if (this.seen.has(m.id)) return;
    this.seen.add(m.id);
    if (this.seen.size > SEEN) this.seen.delete(this.seen.values().next().value);
    this._emit(m.type, m.data ?? {}, m);
  }

  _emit(type, data, msg) {
    for (const key of [type, '*']) {
      for (const fn of this.handlers.get(key) ?? []) {
        try {
          fn(data, msg);
        } catch (e) {
          console.error(`wall bus: ${type}`, e);
        }
      }
    }
  }
}

// ---------- setup and show on disk (dev server) or in localStorage ----------

const localKey = (kind) => `kinect-wall:${kind}`;

function readLocal(kind) {
  try {
    const v = JSON.parse(localStorage.getItem(localKey(kind)));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeLocal(kind, doc) {
  try {
    localStorage.setItem(localKey(kind), JSON.stringify(doc));
  } catch {
    // storage blocked
  }
}

/** Loads 'setup', 'projection' or 'show': { doc, source: 'devserver' | 'local' | 'none' }. */
export async function loadDoc(kind) {
  try {
    const r = await fetch(`/__wall/${kind}`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) {
      const doc = await r.json();
      if (doc && typeof doc === 'object' && Object.keys(doc).length) {
        writeLocal(kind, doc);
        return { doc, source: 'devserver' };
      }
      // the dev server has none yet: maybe this browser has an older one
      const local = readLocal(kind);
      return { doc: local, source: local ? 'local' : 'none' };
    }
  } catch {
    // no dev server (build) or it is restarting
  }
  const local = readLocal(kind);
  return { doc: local, source: local ? 'local' : 'none' };
}

/** Saves 'setup', 'projection' or 'show' (dev server file and localStorage). Returns where it went. */
export async function saveDoc(kind, doc) {
  writeLocal(kind, doc);
  try {
    const r = await fetch(`/__wall/${kind}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc, null, 2),
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) return 'devserver';
  } catch {
    // only in this browser then
  }
  return 'local';
}

/** fn() after `ms` without another call (for saving while a slider moves). */
export function debounce(fn, ms) {
  let timer = null;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  run.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return run;
}
