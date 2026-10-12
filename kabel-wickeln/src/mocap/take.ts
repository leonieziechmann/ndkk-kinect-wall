// A recorded take (mocap/FORMAT.md, version 1): the joints of one person over time, read from
// mocap/takes/<shot>_t<take>.json.gz (gzip JSON; plain JSON works too), sampled at any time.
//
//   Browser (scenes):  yield loadTake(url)  (fetch + DecompressionStream, cached by url), then takeOf(url)
//   Node (bakes, tests): readTakeSync(path)  (node:fs + node:zlib through process.getBuiltinModule,
//                       so this file has no Node imports and loads in the browser too)
//
// Units here: metres and seconds (the file has mm). Positions are in the take's WORLD frame: y up,
// floor at y = 0, origin on the floor below the sensor, +z from the person towards the sensor (a
// person facing the Kinect faces +z, its left hand on +x). Times are the file's: seconds since the
// first frame of the recording; markers.clap is the sync point (take.zero). Pure TypeScript.

import type { V3 } from '../people/math';
import { MIRROR_OF, TAKE_JOINTS, TJ } from './joints';

export const TAKE_FORMAT = 'kabel-wickeln-take';
export const TAKE_VERSION = 1;

/** what the file says about one joint over the whole take */
export interface JointQuality {
  /** mean confidence 0 … 1 */
  conf: number;
  /** fraction of frames whose 3D came from the depth (D) */
  depth_hits: number;
  /** jitter of the measurements around the smoothed curve, mm */
  jitter_mm: number;
  outliers?: number;
}

export interface TakeMarkers {
  /** the clap (sync), s, same time base as the frames; null = not found */
  clap: number | null;
  start: number | null;
  end: number | null;
}

/** a cable polyline of one frame: points in WORLD (m), confidence 0 … 1 */
export interface TakeCable {
  pts: V3[];
  conf: number;
}

/** the raw file (only the fields this reader uses are typed) */
export interface TakeDoc {
  format: string;
  version: number;
  kind: 'take' | 'truth' | string;
  shot: string;
  take: number;
  source?: string;
  recorded_at?: string;
  setup?: string;
  person?: number;
  kinect?: Record<string, unknown>;
  fps: number;
  frames: number;
  t: { t0: number; dt: number } | number[];
  floor?: { normal: number[]; d_mm: number; rms_mm?: number };
  world?: { cam_to_world: number[]; sensor_mm?: number[]; mark_mm?: number[] };
  joints: string[];
  pos: number[][];
  conf: number[][];
  how: string[];
  cable?: ({ pts: number[]; conf: number }[] | null)[] | null;
  quality?: { joints?: Record<string, JointQuality>; warnings?: string[]; [k: string]: unknown };
  markers?: Partial<TakeMarkers>;
  meta?: Record<string, unknown>;
  truth?: Record<string, unknown>;
  [k: string]: unknown;
}

/** one moment of a take: 68 joints (m, WORLD), confidences 0 … 1, how each was measured */
export interface TakeSample {
  t: number;
  p: V3[];
  c: number[];
  /** one character per joint: D depth, I interpolated, B bone length, T truth, - missing */
  how: string;
}

const NJ = TAKE_JOINTS.length;
const MISSING = '-'.charCodeAt(0);

/**
 * A take in memory. Frames are kept as flat arrays (pos: F × 68 × 3 in m, conf: F × 68 in 0 … 1,
 * how: F × 68 character codes); sampling in between frames is a Catmull-Rom spline per joint
 * (linear next to missing frames), the confidence linear, `how` from the nearer frame.
 */
export class Take {
  public readonly shot: string;
  public readonly take: number;
  public readonly kind: string;
  public readonly setup: string;
  /** 1 = the main person, 2 = the second one (p6.lift.pair) */
  public readonly person: number;
  public readonly fps: number;
  public readonly frames: number;
  /** s since the recording's first frame, per frame */
  public readonly time: Float64Array;
  public readonly pos: Float32Array;
  public readonly conf: Float32Array;
  public readonly how: Uint8Array;
  public readonly markers: TakeMarkers;
  public readonly quality: Record<string, JointQuality>;
  /** what the file warns about (German, from auswerten.py) */
  public readonly warnings: string[];
  /** the WORLD point on the floor under the planned mark (m), when the file has it */
  public readonly mark: V3 | null;
  /** the sensor in WORLD (m) */
  public readonly sensor: V3 | null;
  /** true when this is the mirror image of the recording (left and right swapped) */
  public readonly mirrored: boolean;

  public constructor(
    /** the file as read (its big per-frame arrays are dropped once parsed) */
    public readonly doc: TakeDoc,
    /** where it came from (url or path), for messages */
    public readonly name = '',
    arrays?: { time: Float64Array; pos: Float32Array; conf: Float32Array; how: Uint8Array; cable: (TakeCable[] | null)[] | null; mirrored: boolean },
  ) {
    if (doc.format !== TAKE_FORMAT) throw new Error(`${name}: kein Take (format = ${String(doc.format)})`);
    if (doc.version > TAKE_VERSION) console.warn(`${name}: Take-Format Version ${doc.version}, dieser Leser kennt ${TAKE_VERSION}`);
    this.shot = doc.shot;
    this.take = doc.take;
    this.kind = doc.kind;
    this.setup = doc.setup ?? '';
    this.person = doc.person ?? 1;
    this.fps = doc.fps;
    this.markers = { clap: doc.markers?.clap ?? null, start: doc.markers?.start ?? null, end: doc.markers?.end ?? null };
    this.quality = doc.quality?.joints ?? {};
    this.warnings = (doc.quality?.warnings as string[] | undefined) ?? [];
    const mm = (v: number[] | undefined): V3 | null => (v && v.length >= 3 ? [v[0] / 1000, v[1] / 1000, v[2] / 1000] : null);
    this.mark = mm(doc.world?.mark_mm);
    this.sensor = mm(doc.world?.sensor_mm);
    if (arrays) {
      this.frames = arrays.time.length;
      this.time = arrays.time;
      this.pos = arrays.pos;
      this.conf = arrays.conf;
      this.how = arrays.how;
      this.cables = arrays.cable;
      this.mirrored = arrays.mirrored;
      return;
    }
    this.mirrored = false;
    // the joint list may come in another order (or with extra joints): map by name
    const names = doc.joints;
    const col = TAKE_JOINTS.map((n) => names.indexOf(n));
    const missing = TAKE_JOINTS.filter((_, j) => col[j] < 0);
    if (missing.length) console.warn(`${name}: Gelenke fehlen in der Datei: ${missing.join(', ')}`);
    const F = Math.min(doc.pos.length, doc.conf.length, doc.how.length);
    this.frames = F;
    this.time = new Float64Array(F);
    if (Array.isArray(doc.t)) for (let i = 0; i < F; i++) this.time[i] = doc.t[i];
    else for (let i = 0; i < F; i++) this.time[i] = doc.t.t0 + doc.t.dt * i;
    this.pos = new Float32Array(F * NJ * 3);
    this.conf = new Float32Array(F * NJ);
    this.how = new Uint8Array(F * NJ).fill(MISSING);
    for (let i = 0; i < F; i++) {
      const P = doc.pos[i];
      const C = doc.conf[i];
      const H = doc.how[i];
      for (let j = 0; j < NJ; j++) {
        const c = col[j];
        if (c < 0) continue;
        const h = H.charCodeAt(c);
        this.how[i * NJ + j] = h;
        if (h === MISSING) continue;
        this.pos.set([P[3 * c] / 1000, P[3 * c + 1] / 1000, P[3 * c + 2] / 1000], (i * NJ + j) * 3);
        this.conf[i * NJ + j] = Math.max(0, Math.min(1, C[c] / 100));
      }
    }
    this.cables = doc.cable
      ? doc.cable.slice(0, F).map((fr) => (fr ? fr.map((l) => ({ pts: toV3s(l.pts), conf: l.conf / 100 })) : null))
      : null;
    // the big arrays live on in the typed arrays only
    this.doc = { ...doc, pos: [], conf: [], how: [], cable: null };
  }

  private readonly cables: (TakeCable[] | null)[] | null;

  /** the sync point: the clap (s, file time base), or the first frame when no clap was found */
  public get zero(): number {
    return this.markers.clap ?? this.time[0];
  }

  /** time of the first and the last frame, s */
  public get t0(): number {
    return this.time[0];
  }

  public get t1(): number {
    return this.time[this.frames - 1];
  }

  /** a joint's index by name (TAKE_JOINTS) */
  public static joint(name: string): number {
    const j = TJ[name];
    if (j === undefined) throw new Error(`unbekanntes Gelenk ${name}`);
    return j;
  }

  /** position of joint j in frame i (m, WORLD); null when missing */
  public at(i: number, j: number): V3 | null {
    const k = i * NJ + j;
    if (this.how[k] === MISSING) return null;
    return [this.pos[3 * k], this.pos[3 * k + 1], this.pos[3 * k + 2]];
  }

  /** confidence 0 … 1 of joint j in frame i (0 when missing) */
  public confAt(i: number, j: number): number {
    return this.conf[i * NJ + j];
  }

  /** how joint j was measured in frame i ('D', 'I', 'B', 'T', '-') */
  public howAt(i: number, j: number): string {
    return String.fromCharCode(this.how[i * NJ + j]);
  }

  /** the frame before or at t and the fraction to the next one (clamped to the take) */
  public frameAt(t: number): { i: number; u: number } {
    const T = this.time;
    const n = this.frames;
    if (n < 2 || t <= T[0]) return { i: 0, u: 0 };
    if (t >= T[n - 1]) return { i: n - 1, u: 0 };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m;
    }
    return { i: lo, u: (t - T[lo]) / (T[hi] - T[lo] || 1) };
  }

  /** the nearest frame to t */
  public nearest(t: number): number {
    const { i, u } = this.frameAt(t);
    return u > 0.5 && i + 1 < this.frames ? i + 1 : i;
  }

  /**
   * Joint j at time t (m, WORLD): Catmull-Rom through the neighbouring frames (linear where a
   * neighbour is missing); null when both frames around t miss it.
   */
  public position(j: number, t: number): V3 | null {
    const { i, u } = this.frameAt(t);
    const a = this.at(i, j);
    if (u === 0 || i + 1 >= this.frames) return a;
    const b = this.at(i + 1, j);
    if (!a || !b) return u < 0.5 ? a ?? b : b ?? a;
    const p0 = (i > 0 && this.at(i - 1, j)) || null;
    const p3 = (i + 2 < this.frames && this.at(i + 2, j)) || null;
    if (!p0 || !p3) return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    // uniform Catmull-Rom (the frames are evenly spaced, or nearly)
    const u2 = u * u;
    const u3 = u2 * u;
    const w0 = -0.5 * u3 + u2 - 0.5 * u;
    const w1 = 1.5 * u3 - 2.5 * u2 + 1;
    const w2 = -1.5 * u3 + 2 * u2 + 0.5 * u;
    const w3 = 0.5 * u3 - 0.5 * u2;
    return [0, 1, 2].map((k) => w0 * p0[k] + w1 * a[k] + w2 * b[k] + w3 * p3[k]) as V3;
  }

  /** confidence of joint j at time t (linear between frames) */
  public confidence(j: number, t: number): number {
    const { i, u } = this.frameAt(t);
    const a = this.confAt(i, j);
    if (u === 0 || i + 1 >= this.frames) return a;
    return a + (this.confAt(i + 1, j) - a) * u;
  }

  /** all joints at time t; missing ones are [0, 0, 0] with confidence 0 and how '-' */
  public sample(t: number): TakeSample {
    const p: V3[] = [];
    const c: number[] = [];
    let how = '';
    const k = this.nearest(t);
    for (let j = 0; j < NJ; j++) {
      const q = this.position(j, t);
      p.push(q ?? [0, 0, 0]);
      c.push(q ? this.confidence(j, t) : 0);
      how += q ? this.howAt(k, j) : '-';
    }
    return { t, p, c, how };
  }

  /** the cable polylines of the frame nearest to t (m, WORLD); null when the file has no cable search */
  public cableAt(t: number): TakeCable[] | null {
    if (!this.cables) return null;
    return this.cables[this.nearest(t)] ?? [];
  }

  /** the share of frames in which joint j has at least this confidence */
  public coverage(j: number, min = 0.4): number {
    let n = 0;
    for (let i = 0; i < this.frames; i++) if (this.conf[i * NJ + j] >= min) n++;
    return this.frames ? n / this.frames : 0;
  }

  /**
   * The mirror image (a left-handed variant): x → −x in WORLD (a reflection across the vertical
   * plane through the sensor, which a placement then turns and moves anyway) and every left joint
   * swapped with its right one. Cable polylines are mirrored too.
   */
  public mirror(): Take {
    const F = this.frames;
    const pos = new Float32Array(this.pos.length);
    const conf = new Float32Array(this.conf.length);
    const how = new Uint8Array(this.how.length);
    for (let i = 0; i < F; i++) {
      for (let j = 0; j < NJ; j++) {
        const s = i * NJ + MIRROR_OF[j];
        const d = i * NJ + j;
        pos[3 * d] = -this.pos[3 * s];
        pos[3 * d + 1] = this.pos[3 * s + 1];
        pos[3 * d + 2] = this.pos[3 * s + 2];
        conf[d] = this.conf[s];
        how[d] = this.how[s];
      }
    }
    const cable = this.cables ? this.cables.map((fr) => (fr ? fr.map((l) => ({ conf: l.conf, pts: l.pts.map((p) => [-p[0], p[1], p[2]] as V3) })) : null)) : null;
    const q: Record<string, JointQuality> = {};
    for (const [n, v] of Object.entries(this.quality)) q[TAKE_JOINTS[MIRROR_OF[TJ[n]]] ?? n] = v;
    const doc: TakeDoc = { ...this.doc, quality: { ...this.doc.quality, joints: q } };
    return new Take(doc, `${this.name} (gespiegelt)`, { time: this.time, pos, conf, how, cable, mirrored: !this.mirrored });
  }
}

function toV3s(flat: number[]): V3[] {
  const out: V3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i] / 1000, flat[i + 1] / 1000, flat[i + 2] / 1000]);
  return out;
}

// ---------------------------------------------------------------- loading

/** a parsed take from the file's JSON (already decompressed) */
export function parseTake(json: unknown, name = ''): Take {
  if (!json || typeof json !== 'object') throw new Error(`${name}: leere Take-Datei`);
  return new Take(json as TakeDoc, name);
}

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** the JSON of a take file's bytes: gzip (DecompressionStream, browsers and Node ≥ 18) or plain */
export async function decodeTakeBytes(bytes: Uint8Array): Promise<unknown> {
  let text: string;
  if (isGzip(bytes)) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

type NodeProcess = { getBuiltinModule?: (id: string) => unknown; cwd: () => string; versions?: { node?: string } };
const nodeProcess = (): NodeProcess | null => {
  const pr = (globalThis as { process?: NodeProcess }).process;
  return pr?.versions?.node && pr.getBuiltinModule ? pr : null;
};

/** a file path for a url-like name in Node: as is when it exists, else relative to the working directory */
function nodePath(pr: NodeProcess, file: string): string {
  const fs = pr.getBuiltinModule!('node:fs') as typeof import('node:fs');
  const path = pr.getBuiltinModule!('node:path') as typeof import('node:path');
  if (fs.existsSync(file)) return file;
  return path.join(pr.cwd(), file.replace(/^\/+/, ''));
}

/**
 * Reads a take synchronously in Node (bakes, tests): gzip or plain JSON. A path starting with '/'
 * that does not exist is taken relative to the working directory (so the same '/mocap/takes/…'
 * works in a scene's fetch and in a bake run from the project folder).
 */
export function readTakeSync(file: string): Take {
  const pr = nodeProcess();
  if (!pr) throw new Error('readTakeSync geht nur in Node; im Browser: yield loadTake(url)');
  const fs = pr.getBuiltinModule!('node:fs') as typeof import('node:fs');
  const zlib = pr.getBuiltinModule!('node:zlib') as typeof import('node:zlib');
  const p = nodePath(pr, file);
  let buf: Uint8Array = fs.readFileSync(p);
  if (isGzip(buf)) buf = zlib.gunzipSync(buf);
  return parseTake(JSON.parse(new TextDecoder().decode(buf)), file);
}

const loaded = new Map<string, Take>();
const pending = new Map<string, Promise<Take>>();

/**
 * Loads a take once and keeps it by url. In a scene: `yield loadTake('/mocap/takes/…json.gz')`
 * before the first frame, then takeOf(url). In Node it reads the file (readTakeSync).
 */
export function loadTake(url: string): Promise<Take> {
  const have = loaded.get(url);
  if (have) return Promise.resolve(have);
  let p = pending.get(url);
  if (!p) {
    const pr = nodeProcess();
    p = (
      pr && !/^https?:/.test(url)
        ? Promise.resolve(readTakeSync(url))
        : fetch(url, { cache: 'no-cache' })
            .then((r) => {
              if (!r.ok) throw new Error(`Take ${url} fehlt (HTTP ${r.status})`);
              return r.arrayBuffer();
            })
            .then((b) => decodeTakeBytes(new Uint8Array(b)))
            .then((j) => parseTake(j, url))
    ).then((take) => {
      loaded.set(url, take);
      return take;
    });
    p.catch(() => pending.delete(url));
    pending.set(url, p);
  }
  return p;
}

/** a take that loadTake(url) has already loaded */
export function takeOf(url: string): Take {
  const t = loaded.get(url);
  if (!t) throw new Error(`Take ${url} ist nicht geladen: erst yield loadTake('${url}')`);
  return t;
}
