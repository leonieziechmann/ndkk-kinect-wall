// What a scene sees as ctx.kinect: the newest frames from the hub, flags for new data, and (once
// the scene uses WebGPU) GPU textures and buffers that are updated automatically.

import { KinectStream } from './kinect-stream.js';
import { PersonStream, personView, POINTS, MAX_PERSONS } from './persons.js';

export const WIDTH = 512;
export const HEIGHT = 424;
const N = WIDTH * HEIGHT;
// wire name -> property on KinectData
const FRAME_STREAMS = { depth: 'depth', depth_raw: 'depthRaw', ir: 'ir', points: 'points' };
const noneFresh = () => ({ depth: false, depthRaw: false, ir: false, points: false, meta: false, lut: false, persons: false });
// GPU buffer of the person points: per slot (0..16) POINTS then one info entry, two vec4f each
export const PERSON_POINTS = POINTS.length + 1;
const EMPTY_VIEW = Object.freeze(Object.assign([], { all: [], entered: [], left: [], fresh: false, floor: null, seq: null, delayMs: 0, byId: () => null, bySlot: () => null }));

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
    /** Person tracking ('persons' in streams): { list, labels, depth, indices, floor, ... }, see persons.js */
    this.persons = null;
    /** The same as Person objects (ctx.persons): named points in world, room and image space. */
    this.view = EMPTY_VIEW;
    /** -1 or 1 as ctx.xSign (set by the runtime): the world space of the view. */
    this.xSign = -1;
    this._viewSeq = null;
    this._viewSign = 0;
    this._personStream = null;
    this._held = new Map(); // seq -> { depth, ir, ... }: frames waiting for their (delayed) persons
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
        if (prop === 'depth') {
          this.received++;
          this._count++;
          this._personStream?.push(e.detail);
        } else if (prop === 'ir') this._personStream?.pushIr(e.detail);
        if (this._personStream?.delayed) {
          // shown together with the persons of the same frame, which come a few frames later
          let h = this._held.get(e.detail.seq);
          if (!h) this._held.set(e.detail.seq, (h = {}));
          h[prop] = e.detail;
          if (this._held.size > 64) this._held.delete(this._held.keys().next().value);
          return;
        }
        this[prop] = e.detail;
        this._pending[prop] = true;
      });
    }
    this.stream.addEventListener('lut', (e) => {
      this.lut = e.detail;
      this._pending.lut = true;
      this._personStream?.setRays(e.detail.data);
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

  /**
   * Person tracking (runs while a scene asks for 'persons'): configure({...}), statusText, error.
   * Created on first use. With its delayed output (the default) depth, ir and the other frames
   * here are those of the newest persons result, so everything fits together.
   */
  get personTracker() {
    if (!this._personStream) {
      this._personStream = new PersonStream((result) => {
        this.persons = result;
        this._pending.persons = true;
        if (!this._personStream.delayed) return;
        const h = this._held.get(result.seq);
        if (h) {
          for (const [prop, frame] of Object.entries(h)) {
            this[prop] = frame;
            this._pending[prop] = true;
          }
        }
        for (const seq of this._held.keys()) {
          if (seq > result.seq) break;
          this._held.delete(seq);
        }
      });
      if (this.lut) this._personStream.setRays(this.lut.data);
    }
    return this._personStream;
  }

  /** Runtime: subscribes the streams the scene needs (+ lut, meta, status). 'persons' implies depth and ir. */
  setStreams(list) {
    const persons = list.includes('persons');
    if (persons) this.personTracker.start();
    else this._personStream?.stop();
    const wire = list.filter((s) => s !== 'persons');
    if (persons) wire.push('depth', 'ir');
    const want = [...new Set(['lut', 'meta', 'status', ...wire])].sort();
    if (want.join() === this._streams) return;
    this._streams = want.join();
    this.stream.subscribe(want);
  }

  /** Runtime: once per animation frame, before the scene's frame(). */
  beginFrame(now) {
    this._personStream?.tick(now); // delayed person tracking: its result for now (and its frames)
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
    // the Person objects: rebuilt for a new result (or after the mirror changed); entered/left
    // only count in the frame of the update
    const r = this.persons;
    if (r && (r.seq !== this._viewSeq || this.xSign !== this._viewSign)) {
      this.view = personView(r, { xSign: this.xSign, previous: this.view === EMPTY_VIEW ? null : this.view });
      this._viewSeq = r.seq;
      this._viewSign = this.xSign;
      this._viewFresh = true;
    } else if (this.view.fresh) {
      this.view.fresh = false;
      this.view.entered = [];
      this.view.left = [];
      this._viewFresh = false;
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
 * Person tracking (streams: ['persons']), all from the same depth frame:
 *   personLabelTexture  r8uint     slot of the person per pixel (1..16), 0 = no person
 *   personDepthTexture  r32float   depth in meters of person pixels only, 0 elsewhere
 *   personLabelBuffer   storage    u8 slots, four per u32
 *   personDepthBuffer   storage    u16 mm of person pixels, two per u32
 *   personIndexBuffer   storage    array<u32>: the person pixels; count = ctx.kinect.persons.indices.length
 *   personPointBuffer   storage    array<vec4f>: every person's points (see the getter, PERSONS.md)
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

  get personLabelTexture() {
    return this._texture('personLabelTexture', 'r8uint');
  }

  get personDepthTexture() {
    return this._texture('personDepthTexture', 'r32float');
  }

  get personLabelBuffer() {
    return this._buffer('personLabelBuffer', N);
  }

  get personDepthBuffer() {
    return this._buffer('personDepthBuffer', N * 2);
  }

  get personIndexBuffer() {
    return this._buffer('personIndexBuffer', N * 4);
  }

  /**
   * The points of every person (ctx.persons, smoothed), array<vec4f>: for slot s (1..16) and point
   * j (POINTS order, then 24 = info) at index (s * PERSON_POINTS + j) * 2:
   *   [0] u, v (depth image uv 0..1, as kinectUv()), depth m, confidence (0 = not seen)
   *   [1] x, y, z (world m, as ctx.camera / pointAt()), confidence
   *   info: [0] visible (0/1), id, height m, age s   [1] the person's box in depth image uv: u0 v0 u1 v1
   */
  get personPointBuffer() {
    return this._buffer('personPointBuffer', (MAX_PERSONS + 1) * PERSON_POINTS * 32);
  }

  upload(k) {
    const q = this.device.queue;
    const due = (key, fresh) => this._res.has(key) && (fresh || this._new.has(key));
    const size = [WIDTH, HEIGHT];
    if (due('personPointBuffer', k._viewFresh)) {
      const data = (this._points ??= new Float32Array((MAX_PERSONS + 1) * PERSON_POINTS * 8));
      data.fill(0);
      for (const p of k.view.all) {
        if (p.slot < 1 || p.slot > MAX_PERSONS) continue;
        for (let j = 0; j < POINTS.length; j++) {
          const name = POINTS[j];
          const o = (p.slot * PERSON_POINTS + j) * 8;
          const w = p.joints[name];
          const c = p.visible && w ? Math.max(0.01, p.confidence[name] ?? 1) : 0;
          const im = p.image.joints[name];
          if (im) data.set([im[0] / WIDTH, im[1] / HEIGHT, w ? w[2] : 0, c], o);
          if (w) data.set([w[0], w[1], w[2], c], o + 4);
        }
        const o = (p.slot * PERSON_POINTS + POINTS.length) * 8;
        const b = p.image.bbox;
        data.set([p.visible ? 1 : 0, p.id, p.height, p.age, b[0] / WIDTH, b[1] / HEIGHT, b[2] / WIDTH, b[3] / HEIGHT], o);
      }
      q.writeBuffer(this._res.get('personPointBuffer'), 0, data);
      this._new.delete('personPointBuffer');
    }
    const p = k.persons;
    if (p) {
      if (due('personLabelTexture', k.fresh.persons)) {
        q.writeTexture({ texture: this._res.get('personLabelTexture') }, p.labels, { bytesPerRow: WIDTH }, size);
        this._new.delete('personLabelTexture');
      }
      if (due('personDepthTexture', k.fresh.persons)) {
        this._personMeters ??= new Float32Array(N);
        const m = this._personMeters;
        m.fill(0);
        const mm = p.depth;
        const idx = p.indices;
        for (let j = 0; j < idx.length; j++) m[idx[j]] = mm[idx[j]] * 0.001;
        q.writeTexture({ texture: this._res.get('personDepthTexture') }, m, { bytesPerRow: WIDTH * 4 }, size);
        this._new.delete('personDepthTexture');
      }
      if (due('personLabelBuffer', k.fresh.persons)) {
        q.writeBuffer(this._res.get('personLabelBuffer'), 0, p.labels);
        this._new.delete('personLabelBuffer');
      }
      if (due('personDepthBuffer', k.fresh.persons)) {
        q.writeBuffer(this._res.get('personDepthBuffer'), 0, p.depth);
        this._new.delete('personDepthBuffer');
      }
      if (due('personIndexBuffer', k.fresh.persons) && p.indices.length) {
        q.writeBuffer(this._res.get('personIndexBuffer'), 0, p.indices);
        this._new.delete('personIndexBuffer');
      }
    }
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
