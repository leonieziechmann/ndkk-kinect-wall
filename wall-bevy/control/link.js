// link.js — the connection to the output (wall-bevy serves this page): one WebSocket (/ws) with
// messages { type, data }; preview pictures come as binary JPEG. Reconnects by itself (the output
// may restart); a device that is not paired any more (a new code) gets the pairing page.

export class Link {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.open = false;
    this.failures = 0;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.failures = 0;
      this._emit('open', {});
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        this._emit('frame', e.data);
        return;
      }
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m && typeof m.type === 'string') this._emit(m.type, m.data ?? {});
    };
    ws.onclose = () => {
      const was = this.open;
      this.open = false;
      this.ws = null;
      if (was) this._emit('close', {});
      else this.failures++;
      // still paired? (a new code unpairs other devices: then the page shows the pairing)
      if (this.failures >= 2) {
        fetch('/api/ping', { cache: 'no-store' })
          .then((r) => {
            if (r.status === 401) location.reload();
          })
          .catch(() => {});
      }
      setTimeout(() => this.connect(), Math.min(5000, 400 * 1.6 ** this.failures));
    };
  }

  /** Sends to the output (dropped while not connected: the page gets everything anew on reconnect). */
  send(type, data = {}) {
    if (this.open) this.ws.send(JSON.stringify({ type, data }));
  }

  /** fn(data) for messages of `type` ('open', 'close', 'frame' too); returns a function that unsubscribes. */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  _emit(type, data) {
    for (const fn of this.handlers.get(type) ?? []) {
      try {
        fn(data);
      } catch (e) {
        console.error(`link: ${type}`, e);
      }
    }
  }
}

/** fn() after `ms` without another call (for sending while a slider moves). */
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
