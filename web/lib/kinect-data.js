// What a scene sees as ctx.kinect: the newest frames from the hub, flags for new data, and (once
// the scene uses WebGPU) GPU textures and buffers that are updated automatically.

import { KinectStream } from './kinect-stream.js';

export const WIDTH = 512;
export const HEIGHT = 424;
const N = WIDTH * HEIGHT;
// wire name -> property on KinectData
const FRAME_STREAMS = { depth: 'depth', depth_raw: 'depthRaw', ir: 'ir', points: 'points' };
const noneFresh = () => ({ depth: false, depthRaw: false, ir: false, points: false, meta: false, lut: false });

let pinhole = null;
/** Rays of an ideal pinhole Kinect (used until the hub sent the real undistortion table). */
export function pinholeRays() {
  if (!pinhole) {
    pinhole = new Float32Array(N * 2);
    for (let v = 0; v < HEIGHT; v++)
      for (let u = 0; u < WIDTH; u++) {
        pinhole[(v * WIDTH + u) * 2] = (u - 256) / 365.5;
        pinhole[(v * WIDTH + u) * 2 + 1] = (v - 206) / 365.5;
      }
  }
  return pinhole;
}

export class KinectData {
  constructor(url) {
    this.stream = new KinectStream({ url, streams: ['lut', 'meta', 'status'] });
    /** Newest frames: { data, seq, width, height, captureTimeUs, ... } or null. `data` is only
     * valid until the next frame of the same stream arrives: copy it if you need to keep it. */
    this.depth = null; // Uint16Array, mm, 0 = no measurement (temporally smoothed)
    this.depthRaw = null; // Uint16Array, mm, unfiltered
    this.ir = null; // Uint8Array, infrared brightness
    this.points = null; // Int16Array x,y,z in mm (Kinect camera frame)
    this.lut = null; // Float32Array x,y ray per pixel
    this.meta = null; // per-frame JSON: seq, stats { median_mm, centroid_mm, valid_ratio, ... }
    /** true during the animation frame in which new data of that kind arrived */
    this.fresh = noneFresh();
    this._pending = noneFresh();
    this.received = 0; // depth frames received in total
    this.fps = 0; // depth frames per second
    this.latencyMs = 0; // sensor -> shown, smoothed
    this._count = 0;
    this._countSince = performance.now();
    this._streams = '';
    /** set by the runtime once the scene called ctx.webgpu() */
    this.gpu = null;

    for (const [wire, prop] of Object.entries(FRAME_STREAMS)) {
      this.stream.addEventListener(wire, (e) => {
        this[prop] = e.detail;
        this._pending[prop] = true;
        if (prop === 'depth') {
          this.received++;
          this._count++;
        }
      });
    }
    this.stream.addEventListener('lut', (e) => {
      this.lut = e.detail;
      this._pending.lut = true;
    });
    this.stream.addEventListener('frame', (e) => {
      this.meta = e.detail;
      this._pending.meta = true;
    });
  }

  connect() {
    this.stream.connect();
  }

  get connected() {
    return this.stream.connected;
  }

  /** Hub status (1/s): sensor state, fps, latency, ... */
  get status() {
    return this.stream.status;
  }

  /** Depth camera intrinsics: fx, fy, cx, cy, k1..p2 */
  get params() {
    return this.stream.params;
  }

  get sensorState() {
    if (!this.connected) return 'disconnected';
    return this.stream.status?.sensor?.state ?? 'unknown';
  }

  get streaming() {
    return this.sensorState === 'streaming';
  }

  /** Undistorted ray per pixel (x, y): point = (x*z, y*z, z). */
  get rays() {
    return this.lut?.data ?? pinholeRays();
  }

  /** ms since the sensor captured this frame */
  ageMs(frame) {
    return frame ? this.stream.ageMs(frame) : Infinity;
  }

  /** Runtime: subscribes the streams the scene needs (+ lut, meta, status). */
  setStreams(list) {
    const want = [...new Set(['lut', 'meta', 'status', ...list])].sort();
    if (want.join() === this._streams) return;
    this._streams = want.join();
    this.stream.subscribe(want);
  }

  /** Runtime: once per animation frame, before the scene's frame(). */
  beginFrame(now) {
    this.fresh = this._pending;
    this._pending = noneFresh();
    if (this.fresh.depth) {
      const age = this.ageMs(this.depth);
      if (age < 5000) this.latencyMs = this.latencyMs ? 0.9 * this.latencyMs + 0.1 * age : age;
    }
    if (now - this._countSince >= 1000) {
      this.fps = (this._count * 1000) / (now - this._countSince);
      this._count = 0;
      this._countSince = now;
    }
    this.gpu?.upload(this);
  }
}

/**
 * GPU copies of the Kinect data, created on first use and refreshed whenever new data arrives.
 * They are never recreated, so bind groups made in setup() stay valid.
 *
 *   depthTexture  r32float    depth in meters, 0 = no measurement (filterable if the GPU can)
 *   irTexture     r8unorm     infrared brightness 0..1
 *   lutTexture    rg32float   ray x, y per pixel: point = (x*z, y*z, z)
 *   depthBuffer   storage     u16 mm, two per u32 (as sent by the hub)
 *   irBuffer      storage     u8, four per u32
 *   lutBuffer     storage     array<vec2f>
 */
export class KinectGpu {
  constructor(device) {
    this.device = device;
    this.filterable = device.features.has('float32-filterable');
    this._res = new Map();
    this._new = new Set();
    this._meters = null;
  }

  _get(key, make) {
    let r = this._res.get(key);
    if (!r) {
      r = make();
      this._res.set(key, r);
      this._new.add(key);
    }
    return r;
  }

  _texture(key, format) {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    return this._get(key, () => this.device.createTexture({ label: `kinect ${key}`, size: [WIDTH, HEIGHT], format, usage }));
  }

  _buffer(key, size) {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    return this._get(key, () => this.device.createBuffer({ label: `kinect ${key}`, size, usage }));
  }

  get depthTexture() {
    return this._texture('depthTexture', 'r32float');
  }

  get irTexture() {
    return this._texture('irTexture', 'r8unorm');
  }

  get lutTexture() {
    return this._texture('lutTexture', 'rg32float');
  }

  get depthBuffer() {
    return this._buffer('depthBuffer', N * 2);
  }

  get irBuffer() {
    return this._buffer('irBuffer', N);
  }

  get lutBuffer() {
    return this._buffer('lutBuffer', N * 8);
  }

  upload(k) {
    const q = this.device.queue;
    const due = (key, fresh) => this._res.has(key) && (fresh || this._new.has(key));
    const size = [WIDTH, HEIGHT];
    if (k.depth && due('depthTexture', k.fresh.depth)) {
      this._meters ??= new Float32Array(N);
      const mm = k.depth.data;
      for (let i = 0; i < N; i++) this._meters[i] = mm[i] * 0.001;
      q.writeTexture({ texture: this._res.get('depthTexture') }, this._meters, { bytesPerRow: WIDTH * 4 }, size);
      this._new.delete('depthTexture');
    }
    if (k.depth && due('depthBuffer', k.fresh.depth)) {
      q.writeBuffer(this._res.get('depthBuffer'), 0, k.depth.data);
      this._new.delete('depthBuffer');
    }
    if (k.ir && due('irTexture', k.fresh.ir)) {
      q.writeTexture({ texture: this._res.get('irTexture') }, k.ir.data, { bytesPerRow: WIDTH }, size);
      this._new.delete('irTexture');
    }
    if (k.ir && due('irBuffer', k.fresh.ir)) {
      q.writeBuffer(this._res.get('irBuffer'), 0, k.ir.data);
      this._new.delete('irBuffer');
    }
    // the ray tables start as pinhole approximation and get the real LUT once it arrives
    if (due('lutTexture', k.fresh.lut)) {
      q.writeTexture({ texture: this._res.get('lutTexture') }, k.rays, { bytesPerRow: WIDTH * 8 }, size);
      this._new.delete('lutTexture');
    }
    if (due('lutBuffer', k.fresh.lut)) {
      q.writeBuffer(this._res.get('lutBuffer'), 0, k.rays);
      this._new.delete('lutBuffer');
    }
  }
}
