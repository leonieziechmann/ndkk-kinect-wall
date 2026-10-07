// kinect-stream.js — browser client for kinect-hub. ES module, no dependencies.
//
//   import { KinectStream } from '/lib/kinect-stream.js';
//   const kinect = new KinectStream({ streams: ['depth', 'lut'] });
//   kinect.addEventListener('depth', (e) => {
//     const { data, width, height, seq } = e.detail;   // data: Uint16Array, mm, 0 = no measurement
//   });
//   kinect.connect();
//
// Events (CustomEvent, payload in e.detail):
//   open, close, hello, subscribed, status, params, error,
//   depth, depth_raw, ir, points, lut (binary frames, see parseBinary), frame (per-frame JSON meta)
// The connection is re-established automatically (with backoff) and the subscription restored.

const MAGIC = 0x3148324b; // "K2H1"
const KIND_NAMES = { 1: 'depth', 2: 'depth_raw', 3: 'ir', 4: 'points', 16: 'lut' };

export function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * Parses one binary hub message. Typed arrays are views on the received buffer (no copies).
 *   kind 1/2 depth/depth_raw: Uint16Array mm | 3 ir: Uint8Array | 4 points: Int16Array x,y,z mm
 *   16 lut: Float32Array x,y per pixel (point = (x*z, y*z, z); x right, y down, z forward)
 */
export function parseBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 32) return null;
  const v = new DataView(buffer);
  if (v.getUint32(0, true) !== MAGIC) return null;
  const kind = v.getUint8(4);
  const headerLen = v.getUint16(6, true);
  const width = v.getUint16(12, true);
  const height = v.getUint16(14, true);
  const n = width * height;
  const frame = {
    kind,
    name: KIND_NAMES[kind] ?? `kind${kind}`,
    version: v.getUint8(5),
    seq: v.getUint32(8, true),
    width,
    height,
    captureTimeUs: Number(v.getBigUint64(16, true)),
    publishTimeUs: Number(v.getBigUint64(24, true)),
    receivedTimeMs: performance.now(),
    data: null,
  };
  const avail = buffer.byteLength - headerLen;
  const make = (Type, count) => (avail >= count * Type.BYTES_PER_ELEMENT ? new Type(buffer, headerLen, count) : null);
  switch (kind) {
    case 1:
    case 2:
      frame.data = make(Uint16Array, n);
      break;
    case 3:
      frame.data = make(Uint8Array, n);
      break;
    case 4:
      frame.data = make(Int16Array, n * 3);
      break;
    case 16:
      frame.data = make(Float32Array, n * 2);
      break;
    default:
      frame.data = new Uint8Array(buffer, headerLen);
  }
  return frame.data ? frame : null;
}

export class KinectStream extends EventTarget {
  /**
   * @param {object} opts
   * @param {string} [opts.url]        ws://host:port/ws (default: the page's host)
   * @param {string[]} [opts.streams]  depth, depth_raw, ir, points, lut, meta, status
   * @param {number} [opts.maxFps]     limit per-frame streams for this client
   */
  constructor({ url = defaultUrl(), streams = ['depth'], maxFps = null } = {}) {
    super();
    this.url = url;
    this.streams = streams;
    this.maxFps = maxFps;
    this.ws = null;
    this.latest = {}; // newest frame per stream name
    this.hello = null;
    this.status = null;
    this.params = null;
    this.lut = null;
    this.clockOffsetUs = 0; // server clock - local clock
    this._bestRtt = Infinity;
    this._retryMs = 250;
    this._closed = true;
    this._timers = [];
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    this._closed = false;
    this._open();
    return this;
  }

  close() {
    this._closed = true;
    this._timers.forEach(clearTimeout);
    this._timers = [];
    clearInterval(this._pingTimer);
    this.ws?.close();
  }

  /** Changes the subscription; also remembered for reconnects. */
  subscribe(streams, maxFps = this.maxFps) {
    this.streams = streams;
    this.maxFps = maxFps;
    this._send({ type: 'subscribe', streams, ...(maxFps ? { max_fps: maxFps } : {}) });
  }

  /** Server time now, in microseconds since 1970 (uses the measured clock offset). */
  serverNowUs() {
    return (performance.timeOrigin + performance.now()) * 1000 + this.clockOffsetUs;
  }

  /** Age of a frame in ms, from the moment the sensor delivered it. */
  ageMs(frame) {
    return (this.serverNowUs() - frame.captureTimeUs) / 1000;
  }

  _send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timers = this._timers.filter((t) => t !== id);
      fn();
    }, ms);
    this._timers.push(id);
  }

  _open() {
    if (this._closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._emit('error', { message: String(err) });
      this._scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this._retryMs = 250;
      this._bestRtt = Infinity;
      this.subscribe(this.streams, this.maxFps);
      this._ping();
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this._ping(), 5000);
      this._emit('open', {});
    };
    ws.onclose = (e) => {
      clearInterval(this._pingTimer);
      this._emit('close', { code: e.code, reason: e.reason });
      this._scheduleReconnect();
    };
    ws.onerror = () => {}; // followed by onclose
    ws.onmessage = (e) => this._onMessage(e.data);
  }

  _scheduleReconnect() {
    if (this._closed) return;
    this._later(() => this._open(), this._retryMs);
    this._retryMs = Math.min(this._retryMs * 2, 4000);
  }

  _ping() {
    this._send({ type: 'ping', t: performance.now() });
  }

  _onMessage(data) {
    if (data instanceof ArrayBuffer) {
      const frame = parseBinary(data);
      if (!frame) return;
      if (frame.name === 'lut') this.lut = frame;
      this.latest[frame.name] = frame;
      this._emit(frame.name, frame);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        this.hello = msg;
        break;
      case 'status':
        this.status = msg;
        break;
      case 'params':
        this.params = msg.params;
        break;
      case 'frame':
        this.latest.meta = msg;
        break;
      case 'pong': {
        const now = performance.now();
        const rtt = now - msg.t;
        if (rtt <= this._bestRtt * 1.5) {
          // offset from the sample with the smallest round trip
          this._bestRtt = Math.min(this._bestRtt, rtt);
          const localMidUs = (performance.timeOrigin + msg.t + rtt / 2) * 1000;
          this.clockOffsetUs = msg.server_time_us - localMidUs;
        }
        break;
      }
    }
    this._emit(msg.type, msg);
  }
}
